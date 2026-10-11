// BILLING-PARTY-PROVENANCE-FINAL — KANIT ARTIK "GERÇEKTEN CANLI YANIT" DEMEK.
//
// ═══ ÖLÇÜLEN AÇIK (ÜÇÜNCÜ VE SON TUR) ════════════════════════════════════
//
// Markalı kanıt şunu kanıtlıyordu:  "bu nesne fabrikamızdan geçti".
// Şunu KANITLAMIYORDU:              "bu yük canlı Trendyol yanıtından geldi".
//
// Çünkü fabrika `(rastgeleYük, { origin: 'LIVE_PROVIDER_RESPONSE' })` kabul
// ediyordu: güven, çağıranın YAZDIĞI bir DİZGEYDİ. Bu testler o yolun
// KAPANDIĞINI ve kanıtın YALNIZ gerçek çekim sınırında doğduğunu kilitler.
//
// ═══ DÜRÜST SINIR ════════════════════════════════════════════════════════
//
// Süreç içinde gerçek ağ ile taklit taşıma katmanı AYIRT EDİLEMEZ; PROV-3
// zaten `globalThis.fetch`i taklit eder. İddia "taklit edilemez" DEĞİL,
// "güven çağrı yerinde yazılan bir dizge değildir"dir.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
process.env.ORDER_DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const payer = await import('./shipments/shippingBillingParty.ts')
const suratBilling = await import('./shipments/suratBillingParty.ts')
const ingestion = await import('./shipments/trendyolLiveOrderIngestion.ts')

/** Gerçek sağlayıcı paketi şekli (v2 `content[]` elemanı). */
const sellerPackage = () => ({
  packageId: 'PKG-SELLER',
  orderNumber: 'ORD-1',
  whoPays: '1',
  lines: [],
})
const trendyolPackage = () => ({
  packageId: 'PKG-TY',
  orderNumber: 'ORD-2',
  lines: [],
})

const responseBody = (content) =>
  JSON.stringify({ totalElements: content.length, totalPages: 1, page: 0, size: 50, content })

const ORDERS_V2_URL =
  'https://apigw.trendyol.com/integration/order/sellers/277221/v2/orders?page=0&size=50'

/** GERÇEK canlı çekim yolunu taklit TAŞIMA katmanıyla sürer. */
async function driveLiveFetch(content) {
  process.env.CF_IMPORT_ONLY = '1'
  const server = await import(pathToFileURL(join(here, 'index.mjs')).href)
  const originalFetch = globalThis.fetch
  const seenUrls = []
  globalThis.fetch = async (url) => {
    seenUrls.push(String(url))
    return new Response(responseBody(content), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const now = Date.now()
    const result = await server.callTrendyolOrders(
      { sellerId: '277221', apiKey: 'k', apiSecret: 's' },
      { startDate: now - 86_400_000, endDate: now, page: 0, size: 50 },
    )
    return { result, seenUrls }
  } finally {
    globalThis.fetch = originalFetch
  }
}

/* ═══ PROV-1 ═══════════════════════════════════════════════════════════ */

test('PROV-1: rastgele saglayici-sekilli nesne + ELLE bayrak kanit URETEMEZ', async () => {
  // (a) Genel fabrika ARTIK YOK. Kaldirilan sey tam olarak buydu:
  //     createTrendyolOrderContractEvidence(yuk, { origin: 'LIVE_...' })
  assert.equal(
    payer.createTrendyolOrderContractEvidence,
    undefined,
    'cagiran-kontrollu guven yolu HALA ACIK',
  )
  assert.equal(ingestion.createTrendyolOrderContractEvidence, undefined)

  // (b) Elle kurulmus MUKEMMEL nesne reddedilir.
  const forged = {
    packageId: 'PKG-SELLER',
    billingParty: 'TRENDYOL',
    evidence: 'CONFIRMED_PROVIDER_CONTRACT',
    provenance: 'PROVIDER_RAW',
    interpretation: 'elle yazildi',
  }
  assert.equal(payer.isTrustedOrderContractEvidence(forged), false)
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: forged,
    }).provenance,
    'UNKNOWN',
  )

  // (c) Dizge bayragi TASIYAN hicbir disa acik yol KALMADI: kaynakta
  //     `origin` secenegi olarak LIVE_PROVIDER_RESPONSE GECMEZ.
  for (const file of [
    'shipments/suratBillingParty.ts',
    'shipments/shippingBillingParty.ts',
    'shipments/trendyolLiveOrderIngestion.ts',
  ]) {
    const code = stripComments(readFileSync(join(here, file), 'utf8'))
    assert.equal(
      code.includes('LIVE_PROVIDER_RESPONSE'),
      false,
      `guven bayragi HALA var: ${file}`,
    )
  }
})

/* ═══ PROV-2 ═══════════════════════════════════════════════════════════ */

test('PROV-2: genel forensic inceleme CONFIRMED URETEMEZ', () => {
  const payloads = [
    sellerPackage(),
    trendyolPackage(),
    { packageId: 'P', orderNumber: 'N', whoPays: '3' },
    { shipmentPackageId: 'P', lines: [] },
    { marketplace: 'Trendyol', packageId: 'P' },
  ]
  const optionSets = [
    undefined,
    {},
    { rawPayloadAvailability: 'AVAILABLE' },
    // Emekliye ayrilan bayrak: artik HICBIR ETKISI YOK.
    { origin: 'LIVE_PROVIDER_RESPONSE' },
    { origin: 'LIVE_PROVIDER_RESPONSE', rawPayloadAvailability: 'AVAILABLE' },
  ]
  for (const raw of payloads) {
    for (const options of optionSets) {
      const inspection = suratBilling.inspectTrendyolBillingSource({ rawOrder: raw }, options)
      assert.notEqual(
        inspection.evidence,
        'CONFIRMED_PROVIDER_CONTRACT',
        `genel inceleme CONFIRMED URETTI: ${JSON.stringify({ raw, options })}`,
      )
      // Ve markali DEGILDIR — cozumleyiciye verilse bile ORDER_CONTRACT olmaz.
      assert.equal(payer.isTrustedOrderContractEvidence(inspection), false)
    }
  }

  // Ayni sey turetilmis gozlem yuzeyleri icin de gecerlidir.
  assert.notEqual(
    suratBilling.deriveExpectedBillingParty({ rawOrder: sellerPackage() }).evidence,
    'CONFIRMED_PROVIDER_CONTRACT',
  )
  assert.notEqual(
    suratBilling.buildBillingObservation({ order: { rawOrder: sellerPackage() } })
      .expectedBillingEvidence,
    'CONFIRMED_PROVIDER_CONTRACT',
  )
})

/* ═══ PROV-3 ═══════════════════════════════════════════════════════════ */

test('PROV-3: GERCEK canli cekim yolu guvenilir CONFIRMED kanit uretir', async () => {
  const { result, seenUrls } = await driveLiveFetch([sellerPackage(), trendyolPackage()])

  assert.equal(result.ok, true, result.message)
  // Istek GERCEKTEN v2 siparis ucuna gitti (taklit edilen yalnizca TASIMA).
  assert.equal(seenUrls.length, 1)
  assert.match(seenUrls[0], /\/integration\/order\/sellers\/277221\/v2\/orders\?/)

  const evidence = result.orderContractEvidence
  assert.ok(evidence instanceof Map, 'cekim sonucu kanit TASIMALI')
  assert.equal(evidence.size, 2)

  const seller = evidence.get('PKG-SELLER')
  assert.equal(payer.isTrustedOrderContractEvidence(seller), true, 'canli kanit GUVENILIR DEGIL')
  assert.equal(seller.evidence, 'CONFIRMED_PROVIDER_CONTRACT')
  assert.equal(seller.provenance, 'PROVIDER_RAW')

  const resolved = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    orderContractEvidence: seller,
  })
  assert.equal(resolved.payer, 'SELLER_PAYS')
  assert.equal(resolved.provenance, 'ORDER_CONTRACT')
  assert.equal(resolved.reasonCode, 'CONFIRMED_PROVIDER_CONTRACT_EVIDENCE')
  assert.equal(payer.routingGateForPayer(resolved).gate, 'ALLOWED')
})

/* ═══ PROV-4 ═══════════════════════════════════════════════════════════ */

test('PROV-4: AYNI paket SONRADAN kalicidan okununca CONFIRMED URETMEZ', async () => {
  const { result } = await driveLiveFetch([sellerPackage()])
  const live = result.orderContractEvidence.get('PKG-SELLER')
  assert.equal(live.evidence, 'CONFIRMED_PROVIDER_CONTRACT')

  // DB gidis-donusu: marka SERILESTIRMEDE KAYBOLUR — bu bir eksiklik degil,
  // istenen davranistir. Saklanan yuk `UNVERIFIED_HISTORICAL_RAW` kalir.
  const afterRoundTrip = JSON.parse(JSON.stringify(live))
  assert.deepEqual(afterRoundTrip, { ...live }, 'alanlar AYNEN dondu')
  assert.equal(payer.isTrustedOrderContractEvidence(afterRoundTrip), false)
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: afterRoundTrip,
    }).provenance,
    'UNKNOWN',
  )

  // Kalicidan okunan HAM PAKET yeniden incelenirse seviye DUSUKTUR.
  const reloaded = suratBilling.inspectTrendyolBillingSource({ rawOrder: sellerPackage() })
  assert.equal(reloaded.evidence, 'UNVERIFIED_HISTORICAL_RAW')
  assert.equal(reloaded.provenance, 'PROVIDER_RAW')
  assert.equal(payer.isTrustedOrderContractEvidence(reloaded), false)
})

/* ═══ PROV-5 ═══════════════════════════════════════════════════════════ */

test('PROV-5: guvenilir kanidin KOPYASI guveni KAYBEDER', async () => {
  const { result } = await driveLiveFetch([sellerPackage()])
  const live = result.orderContractEvidence.get('PKG-SELLER')

  for (const copy of [
    { ...live },
    Object.assign({}, live),
    Object.freeze({ ...live }),
    structuredClone({ ...live }),
  ]) {
    assert.equal(payer.isTrustedOrderContractEvidence(copy), false, 'kopya GUVENILIR sayildi')
    assert.notEqual(
      payer.resolveShippingBillingParty({
        marketplace: 'trendyol',
        orderContractEvidence: copy,
      }).provenance,
      'ORDER_CONTRACT',
    )
  }
  // Orijinal nesne HALA guvenilir — kopyalama onu bozmaz.
  assert.equal(payer.isTrustedOrderContractEvidence(live), true)
})

/* ═══ PROV-6 ═══════════════════════════════════════════════════════════ */

test('PROV-6: dogrulanmamis kanit ACCOUNT_CONFIG → TENANT_CONFIG → UNKNOWN duser', () => {
  const unverified = suratBilling.inspectTrendyolBillingSource({ rawOrder: sellerPackage() })

  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: unverified,
      marketplaceAccountConfig: 'MARKETPLACE_PAYS',
      tenantConfig: 'SELLER_PAYS',
    }).provenance,
    'ACCOUNT_CONFIG',
  )
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: unverified,
      tenantConfig: 'SELLER_PAYS',
    }).provenance,
    'TENANT_CONFIG',
  )
  const nothing = payer.resolveShippingBillingParty({
    marketplace: 'trendyol',
    orderContractEvidence: unverified,
  })
  assert.equal(nothing.provenance, 'UNKNOWN')
  assert.equal(nothing.payer, 'UNKNOWN')
  assert.equal(payer.routingGateForPayer(nothing).gate, 'CONFIG_REQUIRED')
})

/* ═══ PROV-7 ═══════════════════════════════════════════════════════════ */

test('PROV-7: Trendyol whoPays semantigi AYNEN korunur', async () => {
  const { result } = await driveLiveFetch([
    { packageId: 'A', orderNumber: 'N', whoPays: '1', lines: [] },
    { packageId: 'B', orderNumber: 'N', lines: [] },
    { packageId: 'C', orderNumber: 'N', whoPays: '9', lines: [] },
  ])
  const evidence = result.orderContractEvidence

  // own whoPays='1' → SELLER
  assert.equal(evidence.get('A').billingParty, 'SELLER')
  // property YOK + dogrulanmis saglayici ham paketi → TRENDYOL
  assert.equal(evidence.get('B').billingParty, 'TRENDYOL')
  // desteklenmeyen deger → UNKNOWN (kanit CONFIRMED olsa bile taraf bilinmez)
  assert.equal(evidence.get('C').billingParty, 'UNKNOWN')
  assert.equal(evidence.get('C').evidence, 'CONFIRMED_PROVIDER_CONTRACT')

  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: evidence.get('A'),
    }).payer,
    'SELLER_PAYS',
  )
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: evidence.get('B'),
    }).payer,
    'MARKETPLACE_PAYS',
  )
  // UNKNOWN taraf ORDER_CONTRACT kokeni URETMEZ, alt kaynaga duser.
  assert.equal(
    payer.resolveShippingBillingParty({
      marketplace: 'trendyol',
      orderContractEvidence: evidence.get('C'),
      marketplaceAccountConfig: 'SELLER_PAYS',
    }).provenance,
    'ACCOUNT_CONFIG',
  )
})

/* ═══ PROV-8 ═══════════════════════════════════════════════════════════ */

test('PROV-8: n11/HB/WooCommerce/ikas/Ticimax davranisi DEGISMEDI', async () => {
  const { result } = await driveLiveFetch([sellerPackage()])
  const trendyolEvidence = result.orderContractEvidence.get('PKG-SELLER')

  for (const marketplace of ['n11', 'hepsiburada', 'woocommerce', 'ikas', 'ticimax']) {
    // Kanit sinifi DEGISMEDI: hesap yapilandirmasi gerekir.
    assert.equal(payer.payerEvidenceClass(marketplace), 'ACCOUNT_CONFIG_REQUIRED')

    // Yapilandirma yoksa UNKNOWN; TRENDYOL kaniti BASKA pazaryerine SIZMAZ.
    assert.equal(
      payer.resolveShippingBillingParty({ marketplace }).payer,
      'UNKNOWN',
    )
    assert.equal(
      payer.resolveShippingBillingParty({
        marketplace,
        orderContractEvidence: trendyolEvidence,
      }).provenance,
      'UNKNOWN',
      `${marketplace}: Trendyol kaniti SIZDI`,
    )

    // Hesap ve kiraci yapilandirmasi AYNEN calisir.
    assert.equal(
      payer.resolveShippingBillingParty({
        marketplace,
        marketplaceAccountConfig: 'MARKETPLACE_PAYS',
      }).provenance,
      'ACCOUNT_CONFIG',
    )
    assert.equal(
      payer.resolveShippingBillingParty({ marketplace, tenantConfig: 'SELLER_PAYS' }).provenance,
      'TENANT_CONFIG',
    )
  }
})

/* ═══ SINIR ZARFI: NE KABUL EDİLİR, NE EDİLMEZ ════════════════════════ */

test('PROV-ENVELOPE: sinir zarfi KENDI olcer, cagiranin beyanina GUVENMEZ', () => {
  const okBody = responseBody([sellerPackage()])
  const base = {
    ok: true,
    statusCode: 200,
    requestUrl: ORDERS_V2_URL,
    contentType: 'application/json;charset=UTF-8',
    rawResponseText: okBody,
  }
  assert.equal(ingestion.ingestTrendyolLiveOrderResponse(base).evidenceCount, 1)

  const rejections = [
    [{ ...base, ok: false }, 'NOT_SUCCESSFUL_RESPONSE'],
    [{ ...base, statusCode: 500 }, 'NOT_SUCCESSFUL_RESPONSE'],
    [{ ...base, statusCode: 426 }, 'NOT_SUCCESSFUL_RESPONSE'],
    [{ ...base, statusCode: undefined }, 'NOT_SUCCESSFUL_RESPONSE'],
    // Baska bir Trendyol ucu (claims) siparis sozlesmesi kaniti URETEMEZ.
    [
      { ...base, requestUrl: 'https://apigw.trendyol.com/integration/order/sellers/1/claims' },
      'NOT_ORDERS_V2_ENDPOINT',
    ],
    [{ ...base, requestUrl: 'https://evil.example/v2/orders' }, 'NOT_ORDERS_V2_ENDPOINT'],
    [{ ...base, contentType: 'text/html' }, 'NOT_JSON_BODY'],
    [{ ...base, rawResponseText: '<html>bakim</html>' }, 'NOT_JSON_BODY'],
    [{ ...base, rawResponseText: '' }, 'NOT_JSON_BODY'],
    // COZUMLENMIS NESNE KABUL EDILMEZ: govde METIN olmalidir.
    [{ ...base, rawResponseText: { content: [sellerPackage()] } }, 'NOT_JSON_BODY'],
    [{ ...base, rawResponseText: JSON.stringify({ totalElements: 0 }) }, 'NO_PACKAGE_ARRAY'],
  ]
  for (const [envelope, expected] of rejections) {
    const outcome = ingestion.ingestTrendyolLiveOrderResponse(envelope)
    assert.equal(outcome.accepted, false, `kabul EDILDI: ${expected}`)
    assert.equal(outcome.rejectionCode, expected)
    assert.equal(outcome.evidenceByPackageId.size, 0)
  }

  // Normalize edilmis kopya sinirdan gecse BILE yukseltilmez.
  const normalizedCopy = ingestion.ingestTrendyolLiveOrderResponse({
    ...base,
    rawResponseText: responseBody([
      { packageId: 'P', marketplace: 'Trendyol', customerName: 'x' },
    ]),
  })
  assert.equal(normalizedCopy.accepted, true)
  assert.equal(normalizedCopy.packageCount, 1)
  assert.equal(normalizedCopy.evidenceCount, 0, 'normalize kopya YUKSELTILDI')
})

/* ═══ SINIFLANDIRMA KOPYALANMADI ══════════════════════════════════════ */

// SATIR yorumlari ONCE silinir: bir satir yorumundaki `/*` dizisi (orn.
// "server/subscription/*") blok-yorum silicisini yanlis yerden baslatir ve
// import blogunu YUTAR — tarama sessizce KORLESIR.
function stripComments(source) {
  return source
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

test('PROV-NODUP: siniflandirma ve yol dizgisi KOPYALANMADI', () => {
  const ingest = stripComments(
    readFileSync(join(here, 'shipments', 'trendyolLiveOrderIngestion.ts'), 'utf8'),
  )
  // Trendyol karar mantigi forensic modulde KALIR.
  for (const duplicated of ['whoPays', 'hasOwnField', 'readOwnField', 'classifyTrendyol']) {
    assert.equal(ingest.includes(duplicated), false, `siniflandirma KOPYALANMIS: ${duplicated}`)
  }
  assert.match(ingest, /inspectTrendyolBillingSource/)
  // Uc noktasi dizgisi de kopyalanmaz; tek otoriteye SORULUR.
  assert.equal(ingest.includes('/integration/order/'), false, 'yol dizgisi KOPYALANMIS')
  assert.match(ingest, /isTrendyolOrdersV2Url/)
  // Paket kimligi turetimi de kopyalanmaz.
  assert.match(ingest, /extractPackageIdentityFields/)

  // Cozumleyici de siniflandirmayi yeniden yazmaz.
  const resolver = stripComments(
    readFileSync(join(here, 'shipments', 'shippingBillingParty.ts'), 'utf8'),
  )
  for (const duplicated of ['whoPays', 'hasOwnField', 'readOwnField']) {
    assert.equal(resolver.includes(duplicated), false, `cozumleyicide KOPYA: ${duplicated}`)
  }
})

/* ═══ CANLI YOL: KANIT GERCEKTEN URETIM KODUNDA BASILIYOR ════════════ */

test('PROV-WIRED: kanit URETIM cekim fonksiyonunda basiliyor', () => {
  const source = readFileSync(join(here, 'index.mjs'), 'utf8')
  const start = source.indexOf('async function callTrendyolOrders(credentials, query)')
  assert.ok(start > 0, 'callTrendyolOrders bulunmali')
  const end = source.indexOf('\n}\n', start)
  const body = source.slice(start, end)
  assert.match(body, /ingestTrendyolLiveOrderResponse\(/)
  assert.match(body, /rawResponseText: result\?\.rawResponse/)
  // Ham yanit METNI verilir — cozumlenmis `result.data` DEGIL.
  assert.equal(body.includes('rawResponseText: result?.data'), false)
})
