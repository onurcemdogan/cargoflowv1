const apiBaseUrl = process.env.CARGOFLOW_API_URL || 'http://127.0.0.1:8787'
const candidateCode = String(process.argv[2] || '').trim()
const controlWebSiparisKodu = String(process.argv[3] || '').trim()
const historyDays = Math.max(6, Number(process.env.SURAT_HISTORY_DAYS || 72))

if (!candidateCode || !controlWebSiparisKodu) {
  console.error(
    'Kullanım: node server/surat-serendip-live-check.mjs <aday-TNo> <geçerli-kontrol-WebSiparisKodu>',
  )
  process.exit(2)
}

const configResponse = await fetch(`${apiBaseUrl}/api/local-config/integration`)
const configPayload = await configResponse.json()
if (!configResponse.ok || !configPayload?.config?.surat) {
  console.error('Yerel şifreli Sürat ayarları okunamadı.')
  process.exit(2)
}

const surat = configPayload.config.surat
const trackingConfig = {
  ...surat,
  trackingServiceType: 'KargoTakipHareketDetayiSoap',
}
const [candidateTracking, controlTracking] = await Promise.all([
  queryTracking(candidateCode),
  queryTracking(controlWebSiparisKodu),
])
const history = await searchShipmentHistory(candidateCode, historyDays)
const candidateVerified = Boolean(
  Number(candidateTracking.gonderilerLength || 0) > 0 || history.found,
)
const controlVerified = Number(controlTracking.gonderilerLength || 0) > 0

console.log(
  JSON.stringify(
    {
      candidateCode,
      candidateVerified,
      candidateTracking: safeTracking(candidateTracking),
      shipmentHistory: history,
      controlWebSiparisKodu,
      controlVerified,
      controlTracking: safeTracking(controlTracking),
      verdict: !controlVerified
        ? 'CONTROL_FAILED'
        : candidateVerified
          ? 'SERENDIP_VERIFIED'
          : 'SERENDIP_RECORD_NOT_FOUND',
    },
    null,
    2,
  ),
)

if (!controlVerified) process.exit(2)
if (!candidateVerified) process.exit(1)

async function queryTracking(webSiparisKodu) {
  const response = await fetch(`${apiBaseUrl}/api/shipments/surat/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: trackingConfig,
      webSiparisKodu,
    }),
  })
  return response.json()
}

async function searchShipmentHistory(code, days) {
  const cariKodu = firstNonEmpty(surat.liveKullaniciAdi, surat.kullaniciAdi)
  const webPassword = firstNonEmpty(
    surat.liveWebPassword,
    surat.webPassword,
  )
  if (!cariKodu || !webPassword) {
    return {
      found: false,
      windowsChecked: 0,
      daysChecked: 0,
      error: 'CariKodu veya WebPassword eksik.',
    }
  }

  let found = false
  let windowsChecked = 0
  for (let offset = 0; offset < days; offset += 6) {
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() - offset)
    const start = new Date(end)
    start.setDate(start.getDate() - 5)
    const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CariKoduveSifre xmlns="http://tempuri.org/">
      <GonderenCariKodu>${xmlEscape(cariKodu)}</GonderenCariKodu>
      <WebPassword>${xmlEscape(webPassword)}</WebPassword>
      <BasTar>${formatDate(start)}</BasTar>
      <BitTar>${formatDate(end)}</BitTar>
      <IsWebSiparisKoduOlsun>true</IsWebSiparisKoduOlsun>
    </CariKoduveSifre>
  </soap:Body>
</soap:Envelope>`
    const response = await fetch(
      'https://webservices.suratkargo.com.tr/services.asmx',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '"http://tempuri.org/CariKoduveSifre"',
        },
        body,
      },
    )
    const text = await response.text()
    windowsChecked += 1
    if (text.includes(code)) {
      found = true
      break
    }
  }
  return { found, windowsChecked, daysChecked: days }
}

function safeTracking(value = {}) {
  return {
    ok: Boolean(value.ok),
    gonderilerLength: Number(value.gonderilerLength || 0),
    KargoTakipNo: String(
      value.KargoTakipNo || value.tracking?.KargoTakipNo || '',
    ),
    trackingReference: String(value.trackingReference || ''),
    message: String(value.message || value.originalMessage || '').slice(0, 240),
    state: String(value.state || value.trackingState || ''),
  }
}

function firstNonEmpty(...values) {
  return String(values.find((value) => String(value || '').trim()) || '').trim()
}

function formatDate(value) {
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-')
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
