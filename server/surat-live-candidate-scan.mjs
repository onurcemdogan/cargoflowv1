import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const apiBaseUrl = process.env.CARGOFLOW_API_URL || 'http://127.0.0.1:8787'
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
        statuses: ['Created', 'Picking', 'Invoiced'],
        startDate,
        endDate,
        size: 200,
        maxPages: 20,
      },
    }),
  },
)
const ordersPayload = await ordersResponse.json()
if (!ordersResponse.ok || !ordersPayload.ok) {
  console.error(
    JSON.stringify({
      ok: false,
      source: 'Trendyol real API',
      responseStatus: ordersResponse.status,
      message: ordersPayload.message || 'Trendyol aktif paket sorgusu basarisiz.',
    }),
  )
  process.exit(1)
}

const store = await readCreateOperationStore()
const operationRecords = Object.values(store.operations || store)
const normalizedOrders = deduplicateOrders(ordersPayload.orders || [])
  .filter((order) => /s[uü]rat/i.test(resolveCargoProvider(order)))
  .sort((left, right) => resolveOrderTime(right) - resolveOrderTime(left))

const candidates = []
for (const order of normalizedOrders.slice(0, 15)) {
  const orderNumber = String(order.orderNumber || '')
  const packageId = String(order.packageId || order.shipmentPackageId || '')
  const shipmentPackageId = String(order.shipmentPackageId || packageId)
  const cargoTrackingNumber = String(order.cargoTrackingNumber || '')
  const identifiers = [
    orderNumber,
    packageId,
    shipmentPackageId,
    cargoTrackingNumber,
    String(order.id || ''),
  ].filter(Boolean)
  const matchingOperations = operationRecords.filter((record) => {
    const serialized = JSON.stringify(record)
    return identifiers.some((identifier) => serialized.includes(identifier))
  })
  const tracking = cargoTrackingNumber
    ? await queryTracking(integration.surat, cargoTrackingNumber)
    : { gonderilerLength: 0, ok: false, message: 'cargoTrackingNumber eksik.' }
  const registeredShipment = cargoTrackingNumber
    ? await queryRegisteredShipment(integration.surat, cargoTrackingNumber)
    : { rowCount: 0 }
  const address = order.shipmentAddress || order.rawOrder?.shipmentAddress || {}
  const city = String(address.city || order.city || '').trim()
  const district = String(address.district || order.district || '').trim()
  const fullAddress = String(
    address.fullAddress || address.address1 || order.address || '',
  ).trim()
  const status = String(
    order.marketplaceStatus || order.packageStatus || order.rawStatus || '',
  )
  const activeStatus = ['Created', 'Picking', 'Invoiced'].includes(status)
  const noCreateHistory = matchingOperations.every(
    (record) => Number(record?.createCallCount || 0) === 0,
  )
  const noCarrierRecord =
    Number(tracking.gonderilerLength || 0) === 0 &&
    Number(registeredShipment.rowCount || 0) === 0
  const eligible = Boolean(
    activeStatus &&
      cargoTrackingNumber &&
      fullAddress &&
      city &&
      district &&
      noCreateHistory &&
      noCarrierRecord,
  )

  candidates.push({
    orderNumber,
    packageId,
    shipmentPackageId,
    orderDate: String(order.orderDate || order.createdDate || ''),
    status,
    carrier: resolveCargoProvider(order),
    ozelKargoTakipNo: cargoTrackingNumber,
    addressComplete: Boolean(fullAddress && city && district),
    phonePresent: Boolean(
      String(order.customerPhone || address.phone || '').trim(),
    ),
    desi: Number(order.desi || 0) || 2,
    desiSource: Number(order.desi || 0) > 0
      ? String(order.desiSource || 'order')
      : 'MANUAL_USER_CONFIRMED',
    createCallCount: matchingOperations.reduce(
      (sum, record) => sum + Number(record?.createCallCount || 0),
      0,
    ),
    idempotencyRecordCount: matchingOperations.length,
    trackingGonderiler: Number(tracking.gonderilerLength || 0),
    registeredShipmentRows: Number(registeredShipment.rowCount || 0),
    registeredTrackingNumber: String(registeredShipment.KargoTakipNo || ''),
    eligible,
    reason: eligible
      ? 'Temiz ve guncel canli test adayi.'
      : buildReason({
          activeStatus,
          cargoTrackingNumber,
          addressComplete: Boolean(fullAddress && city && district),
          noCreateHistory,
          noCarrierRecord,
        }),
  })
  if (candidates.filter((candidate) => candidate.eligible).length >= 5) break
}

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      source: 'Trendyol real API + CargoFlow idempotency + Sürat read-only services',
      rawActiveOrderCount: Number(ordersPayload.orders?.length || 0),
      activeSuratOrderCount: normalizedOrders.length,
      eligibleCount: candidates.filter((candidate) => candidate.eligible).length,
      candidates: candidates.slice(0, 15),
    },
    null,
    2,
  ),
)

function deduplicateOrders(orders) {
  const map = new Map()
  for (const order of orders) {
    const key = String(
      order.packageId || order.shipmentPackageId || order.orderNumber || order.id,
    )
    if (!key || map.has(key)) continue
    map.set(key, order)
  }
  return [...map.values()]
}

function resolveCargoProvider(order) {
  return String(
    order.cargoProviderName ||
      order.cargoCompany ||
      order.rawOrder?.cargoProviderName ||
      '',
  )
}

function resolveOrderTime(order) {
  const value = order.orderDate || order.createdDate || order.rawOrder?.orderDate
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function buildReason(gates) {
  return Object.entries(gates)
    .filter(([, value]) => !value)
    .map(([key]) => key)
    .join(', ')
}

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
    WebSiparisKodu: rowCount > 0 ? extractTag(text, 'WebSiparisKodu') : '',
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
