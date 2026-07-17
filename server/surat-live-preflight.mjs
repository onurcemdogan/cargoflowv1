import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const apiBaseUrl = process.env.CARGOFLOW_API_URL || 'http://127.0.0.1:8787'
const orderNumber = String(process.argv[2] || '').trim()
const manualDesi = Number(process.argv[3] || 0)
if (!orderNumber) {
  console.error(
    'Kullanim: node server/surat-live-preflight.mjs <orderNumber> [manualDesi]',
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
  console.log(
    JSON.stringify(
      {
        eligible: false,
        orderNumber,
        reason: !ordersPayload.ok
          ? ordersPayload.message || 'Trendyol API sorgusu basarisiz.'
          : 'Siparis aktif Created/Picking/Invoiced kayitlarinda bulunamadi.',
        responseStatus: ordersResponse.status,
        freshApiOrderCount: Number(ordersPayload.orders?.length || 0),
      },
      null,
      2,
    ),
  )
  process.exit(1)
}

const packageId = String(order.packageId || order.shipmentPackageId || '')
const shipmentPackageId = String(order.shipmentPackageId || packageId)
const cargoTrackingNumber = String(order.cargoTrackingNumber || '')
const operationStore = await readCreateOperationStore()
const operationRecords = operationStore.operations || operationStore
const matchingOperations = Object.entries(operationRecords)
  .filter(([, record]) => {
    const serialized = JSON.stringify(record)
    return [orderNumber, packageId, shipmentPackageId, cargoTrackingNumber]
      .filter(Boolean)
      .some((value) => serialized.includes(value))
  })
  .map(([key, record]) => ({
    key,
    status: String(record?.status || ''),
    createCallCount: Number(record?.createCallCount || 0),
    operation: String(record?.operation || ''),
    candidateTrackingNumber: String(record?.candidateTrackingNumber || ''),
    candidateBarcodeNumber: String(record?.candidateBarcodeNumber || ''),
  }))

const carrierIdentityChecks = await Promise.all(
  [
    ['orderNumber', orderNumber],
    ['packageId', packageId],
    ['cargoTrackingNumber', cargoTrackingNumber],
  ]
    .filter(([, value]) => Boolean(value))
    .map(async ([identityType, value]) => {
      const [trackingResult, shipmentResult] = await Promise.all([
        queryTracking(integration.surat, value),
        queryRegisteredShipment(integration.surat, value),
      ])
      return {
        identityType,
        value,
        trackingGonderiler: Number(trackingResult.gonderilerLength || 0),
        trackingKargoTakipNo: String(
          trackingResult.KargoTakipNo ||
            trackingResult.tracking?.KargoTakipNo ||
            '',
        ),
        registeredShipmentRows: Number(shipmentResult.rowCount || 0),
        registeredKargoTakipNo: String(shipmentResult.KargoTakipNo || ''),
        registeredBarcodeNo: String(shipmentResult.BarkodNo || ''),
      }
    }),
)
const tracking =
  carrierIdentityChecks.find(
    (check) => check.identityType === 'cargoTrackingNumber',
  ) || { trackingGonderiler: 0 }
const raw = order.rawOrder || {}
const address = order.shipmentAddress || raw.shipmentAddress || {}
const phone = String(
  order.customerPhone || address.phone || raw.customerPhone || '',
).trim()
const city = String(address.city || order.city || '').trim()
const district = String(address.district || order.district || '').trim()
const fullAddress = String(address.fullAddress || address.address1 || order.address || '').trim()
const desi = manualDesi > 0 ? manualDesi : Number(order.desi || 0)
const desiSource =
  manualDesi > 0
    ? 'MANUAL_USER_CONFIRMED'
    : String(order.desiSource || '')
const status = String(order.marketplaceStatus || order.packageStatus || order.rawStatus || '')
const paymentType =
  raw.isCod === false
    ? 'seller_pays'
    : raw.isCod === true
      ? 'cash_on_delivery'
      : String(order.paymentType || raw.paymentType || '').trim()
const cargoProviderName = String(order.cargoProviderName || order.cargoCompany || '')
const assignedToSurat = /s[uü]rat/i.test(cargoProviderName)
const activeStatus = ['Created', 'Picking', 'Invoiced'].includes(status)
const createReadyStatus = ['Picking', 'Hazırlanıyor', 'Hazirlaniyor'].includes(status)
const requiresPickingUpdate = status === 'Created'
const statusCanProceed = createReadyStatus || requiresPickingUpdate
const addressComplete = Boolean(fullAddress && city && district)
const noCreateHistory = matchingOperations.every(
  (record) => record.createCallCount === 0,
)
const noSerendipRecord = carrierIdentityChecks.every(
  (check) =>
    check.trackingGonderiler === 0 && check.registeredShipmentRows === 0,
)
const eligible = Boolean(
  orderNumber === String(order.orderNumber) &&
    activeStatus &&
    statusCanProceed &&
    assignedToSurat &&
    addressComplete &&
    desi > 0 &&
    paymentType &&
    cargoTrackingNumber &&
    noCreateHistory &&
    noSerendipRecord,
)

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      source: 'Trendyol real API + local idempotency + Sürat read-only tracking',
      eligible,
      orderNumber: String(order.orderNumber || ''),
      packageId,
      shipmentPackageId,
      cargoTrackingNumber,
      marketplaceStatus: status,
      cargoProviderName,
      assignedToSurat,
      paymentType,
      recipientNamePresent: Boolean(order.customerName || address.fullName),
      phonePresent: Boolean(phone),
      phoneRequirement: 'OPTIONAL_IN_GONDERIMODEL_WSDL',
      addressComplete,
      city,
      district,
      desi,
      desiSource,
      labelStatus: String(order.labelStatus || ''),
      operationStatus: String(order.operationStatus || ''),
      existingShipment: Boolean(order.shipment),
      matchingOperations,
      carrierIdentityChecks,
      trackingPrecheck: {
        operation: 'KargoTakipHareketDetayi',
        requestField: 'WebSiparisKodu',
        candidate: cargoTrackingNumber,
        gonderilerLength: tracking.trackingGonderiler,
        KargoTakipNo: tracking.trackingKargoTakipNo || '',
      },
      gates: {
        activeStatus,
        createReadyStatus,
        requiresPickingUpdate,
        statusCanProceed,
        assignedToSurat,
        addressComplete,
        phonePresent: Boolean(phone),
        phoneOptional: true,
        desiPresent: desi > 0,
        paymentTypePresent: Boolean(paymentType),
        cargoTrackingNumberPresent: Boolean(cargoTrackingNumber),
        noCreateHistory,
        noSerendipRecord,
      },
    },
    null,
    2,
  ),
)

async function queryTracking(surat, webSiparisKodu) {
  const response = await fetch(`${apiBaseUrl}/api/shipments/surat/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        ...surat,
        trackingServiceType: 'KargoTakipHareketDetayiSoap',
      },
      webSiparisKodu,
      queryReference: {
        value: webSiparisKodu,
        type: 'WEB_SIPARIS_KODU',
        source: 'order.cargoTrackingNumber -> createRequest.OzelKargoTakipNo',
      },
    }),
  })
  return response.json()
}

async function queryRegisteredShipment(surat, webSiparisKodu) {
  const cariKodu = firstNonEmpty(surat.liveKullaniciAdi, surat.kullaniciAdi)
  const sifre = firstNonEmpty(surat.liveSifre, surat.sifre)
  if (!cariKodu || !sifre) return { rowCount: 0, error: 'credentials_missing' }
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <WebSiparisKodu xmlns="http://tempuri.org/">
      <GonderenCariKodu>${xmlEscape(cariKodu)}</GonderenCariKodu>
      <Sifre>${xmlEscape(sifre)}</Sifre>
      <WebSiparisKodu>${xmlEscape(webSiparisKodu)}</WebSiparisKodu>
    </WebSiparisKodu>
  </soap:Body>
</soap:Envelope>`
  const response = await fetch(
    'https://webservices.suratkargo.com.tr/services.asmx',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '"http://tempuri.org/WebSiparisKodu"',
      },
      body,
    },
  )
  const text = decodeXml(await response.text())
  const rowCount = [...text.matchAll(/<Table(?:\s[^>]*)?>/gi)].length
  return {
    responseStatus: response.status,
    rowCount,
    KargoTakipNo: rowCount > 0 ? extractTag(text, 'TakipNo') : '',
    BarkodNo: rowCount > 0 ? extractTag(text, 'Barkod') : '',
  }
}

async function readCreateOperationStore() {
  try {
    const directory =
      process.env.CARGOFLOW_CONFIG_DIR ||
      join(process.env.LOCALAPPDATA || homedir(), 'CargoFlow')
    return JSON.parse(
      await readFile(join(directory, 'surat-create-operations.json'), 'utf8'),
    )
  } catch {
    return {}
  }
}

function firstNonEmpty(...values) {
  return String(values.find((value) => String(value || '').trim()) || '').trim()
}

function extractTag(text, tag) {
  const match = String(text).match(
    new RegExp(
      `<(?:(?:\\w+):)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`,
      'i',
    ),
  )
  return decodeXml(match?.[1] || '').trim()
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
