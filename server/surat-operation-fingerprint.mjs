const apiBaseUrl = process.env.CARGOFLOW_API_URL || 'http://127.0.0.1:8787'
const webSiparisKodu = String(process.argv[2] || '').trim()
const tNo = String(process.argv[3] || '').trim()
const orderId = String(process.argv[4] || '').trim()

if (!webSiparisKodu || !tNo) {
  console.error(
    'Kullanim: node server/surat-operation-fingerprint.mjs <WebSiparisKodu> <TNo> [orderId]',
  )
  process.exit(2)
}

const configResponse = await fetch(`${apiBaseUrl}/api/local-config/integration`)
const configPayload = await configResponse.json()
const surat = configPayload?.config?.surat
if (!configResponse.ok || !surat) {
  console.error('Yerel sifreli Surat ayarlari okunamadi.')
  process.exit(2)
}

const cariKodu = firstNonEmpty(surat.liveKullaniciAdi, surat.kullaniciAdi)
const sifre = firstNonEmpty(surat.liveSifre, surat.sifre)
const webPassword = firstNonEmpty(surat.liveWebPassword, surat.webPassword)
if (!cariKodu || !sifre) {
  console.error('Surat CariKodu veya Sifre eksik.')
  process.exit(2)
}

const trackingResults = []
for (const candidate of [
  {
    value: webSiparisKodu,
    type: 'WEB_SIPARIS_KODU',
    source: 'known-good createRequest.OzelKargoTakipNo',
  },
  {
    value: tNo,
    type: 'T_NO',
    source: 'known-good canonical KargoTakipNo negative control',
  },
]) {
  const response = await fetch(`${apiBaseUrl}/api/shipments/surat/track`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config: {
        ...surat,
        trackingServiceType: 'KargoTakipHareketDetayiSoap',
      },
      webSiparisKodu: candidate.value,
      queryReference: candidate,
      orderId:
        candidate.type === 'WEB_SIPARIS_KODU' && orderId
          ? orderId
          : undefined,
    }),
  })
  trackingResults.push({
    candidate: candidate.value,
    candidateType: candidate.type,
    operation: 'KargoTakipHareketDetayi',
    soapAction: 'http://tempuri.org/KargoTakipHareketDetayi',
    requestRoot: 'KargoTakipHareketDetayi',
    requestField: 'WebSiparisKodu',
    responseStatus: response.status,
    ...safeTracking(await response.json()),
  })
}

const barcodeResults = []
if (webPassword) {
  const result = await callSoap(
    'KargoBarkodu',
    `<cariKodu>${xmlEscape(cariKodu)}</cariKodu>
     <WebPassword>${xmlEscape(webPassword)}</WebPassword>
     <ozelKargoTakipNo>${xmlEscape(webSiparisKodu)}</ozelKargoTakipNo>`,
  )
  barcodeResults.push({
    candidate: webSiparisKodu,
    candidateType: 'OZEL_KARGO_TAKIP_NO',
    operation: 'KargoBarkodu',
    soapAction: 'http://tempuri.org/KargoBarkodu',
    requestRoot: 'KargoBarkodu',
    requestField: 'ozelKargoTakipNo',
    responseStatus: result.statusCode,
    ...safeBarcodeResult(result.text),
  })
} else {
  barcodeResults.push({
    operation: 'KargoBarkodu',
    skipped: true,
    reason: 'WebPassword eksik.',
  })
}

const registeredShipmentResults = []
for (const candidate of [
  {
    operation: 'WebSiparisKodu',
    label: 'known-good customer reference',
    fields: {
      GonderenCariKodu: cariKodu,
      Sifre: sifre,
      WebSiparisKodu: webSiparisKodu,
    },
  },
  {
    operation: 'TakipNo',
    label: 'known-good canonical T.No',
    fields: {
      GonderenCariKodu: cariKodu,
      TakipNo: tNo,
      Sifre: sifre,
    },
  },
]) {
  const result = await callSoap(
    candidate.operation,
    Object.entries(candidate.fields)
      .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
      .join('\n'),
  )
  registeredShipmentResults.push({
    label: candidate.label,
    operation: candidate.operation,
    soapAction: `http://tempuri.org/${candidate.operation}`,
    responseStatus: result.statusCode,
    ...safeRegisteredShipmentResult(result.text),
  })
}

const history = webPassword
  ? await searchHistory([webSiparisKodu, tNo])
  : { skipped: true, reason: 'WebPassword eksik.' }

console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      trackingResults,
      registeredShipmentResults,
      barcodeResults,
      history,
    },
    null,
    2,
  ),
)

function safeRegisteredShipmentResult(xml) {
  const decoded = decodeXml(xml)
  const rows = [...decoded.matchAll(/<Table(?:\s[^>]*)?>([\s\S]*?)<\/Table>/gi)]
    .map((match) => match[1])
  const rowCount = rows.length
  const firstRow = rows[0] || ''
  return {
    rowCount,
    WebSiparisKodu: rowCount > 0 ? extractTag(firstRow, 'WebSiparisKodu') : '',
    KargoTakipNo:
      rowCount > 0
        ? firstNonEmpty(
            extractTag(firstRow, 'TakipNo'),
            extractTag(firstRow, 'KargoTakipNo'),
          )
        : '',
    BarkodNo:
      rowCount > 0
        ? firstNonEmpty(
            extractTag(firstRow, 'Barkod'),
            extractTag(firstRow, 'BarkodNo'),
          )
        : '',
    Durum: rowCount > 0 ? extractTag(firstRow, 'Durum') : '',
  }
}

async function searchHistory(candidates) {
  const matches = new Map(candidates.map((candidate) => [candidate, false]))
  let windowsChecked = 0
  let lastStatus = 0
  for (let offset = 0; offset < 90; offset += 6) {
    const end = new Date()
    end.setDate(end.getDate() - offset)
    const start = new Date(end)
    start.setDate(start.getDate() - 5)
    const result = await callSoap(
      'CariKoduveSifre',
      `<GonderenCariKodu>${xmlEscape(cariKodu)}</GonderenCariKodu>
       <WebPassword>${xmlEscape(webPassword)}</WebPassword>
       <BasTar>${formatDate(start)}</BasTar>
       <BitTar>${formatDate(end)}</BitTar>
       <IsWebSiparisKoduOlsun>true</IsWebSiparisKoduOlsun>`,
    )
    const decoded = decodeXml(result.text)
    lastStatus = result.statusCode
    windowsChecked += 1
    for (const candidate of candidates) {
      if (decoded.includes(candidate)) matches.set(candidate, true)
    }
    if ([...matches.values()].every(Boolean)) break
  }
  return {
    operation: 'CariKoduveSifre',
    soapAction: 'http://tempuri.org/CariKoduveSifre',
    requestRoot: 'CariKoduveSifre',
    requestFields: ['GonderenCariKodu', 'WebPassword', 'BasTar', 'BitTar'],
    responseStatus: lastStatus,
    windowsChecked,
    matches: candidates.map((candidate) => ({
      candidate,
      found: matches.get(candidate),
    })),
  }
}

async function callSoap(operation, innerXml) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${operation} xmlns="http://tempuri.org/">
      ${innerXml}
    </${operation}>
  </soap:Body>
</soap:Envelope>`
  const response = await fetch(
    'https://webservices.suratkargo.com.tr/services.asmx',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"http://tempuri.org/${operation}"`,
      },
      body,
    },
  )
  return {
    statusCode: response.status,
    text: await response.text(),
  }
}

function safeTracking(value = {}) {
  const tracking = value.tracking || {}
  return {
    ok: Boolean(value.ok),
    responseRoot: 'KargoTakipHareketDetayiResult',
    message: String(value.message || value.originalMessage || '').slice(0, 240),
    gonderilerLength: Number(value.gonderilerLength || 0),
    KargoTakipNo: String(value.KargoTakipNo || tracking.KargoTakipNo || ''),
    BarkodNo: String(value.BarkodNo || tracking.BarkodNo || tracking.Barkod || ''),
    Satiskodu: String(tracking.Satiskodu || ''),
    KargonunDurumu: String(tracking.KargonunDurumu || ''),
    trackingState: String(value.trackingState || ''),
  }
}

function safeBarcodeResult(xml) {
  const decoded = decodeXml(xml)
  return {
    responseRoot: 'KargoBarkoduResult',
    OzelKargoTakipNo: extractTag(decoded, 'OzelKargoTakipNo'),
    KargoTakipNo: extractTag(decoded, 'KargoTakipNo'),
    BarkodNo: extractTags(decoded, 'string').filter((value) => /^\d{8,20}$/.test(value)),
    Aciklama: extractTag(decoded, 'Aciklama'),
    pdfBarkodAvailable: Boolean(extractTag(decoded, 'PdfBarkod')),
  }
}

function extractTag(text, tag) {
  const match = String(text).match(
    new RegExp(`<(?:(?:\\w+):)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`, 'i'),
  )
  return decodeXml(match?.[1] || '').trim()
}

function extractTags(text, tag) {
  return [...String(text).matchAll(
    new RegExp(`<(?:(?:\\w+):)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}>`, 'gi'),
  )].map((match) => decodeXml(match[1]).trim()).filter(Boolean)
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
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
