import assert from 'node:assert/strict'
import test from 'node:test'

// P4 — HEPSIBURADA + N11 TEMEL SÖZLEŞMESİ.
//
// Fixture'lar YALNIZ resmî dokümante ŞEKİLLERDEN türetildi (Hepsiburada
// Developer Portal · n11 Mağaza Destek Merkezi, 2026-08-19).
//
// AĞ YOK · DB YOK · GERÇEK PAZARYERİ MUTASYONU YOK.

const HB = await import('./marketplaces/hepsiburada/hepsiburadaContract.ts')
const HBO = await import('./marketplaces/hepsiburada/hepsiburadaOrderSource.ts')
const HBL = await import('./marketplaces/hepsiburada/hepsiburadaLabelCapability.ts')
const N11 = await import('./marketplaces/n11/n11Contract.ts')
const N11O = await import('./marketplaces/n11/n11OrderSource.ts')
const SEAM = await import('./marketplaces/marketplaceOrderSource.ts')

const NOW = Date.parse('2026-08-19T12:00:00Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/* ═══════════════ HEPSIBURADA — HOST / SIT KURALI ═══════════════════ */

test('HB-1: -sit kaldirma kurali YALNIZ dogrulanmis HB hostlarinda calisir', () => {
  const sit = HB.resolveHepsiburadaHost({
    host: 'oms-external-sit.hepsiburada.com', environment: 'PRODUCTION',
  })
  assert.equal(sit.ok, true)
  assert.equal(sit.host, 'oms-external.hepsiburada.com')
  assert.equal(sit.environment, 'PRODUCTION')

  // Yabanci host: kural UYGULANMAZ. Aksi halde ilgisiz bir adreste sessizce
  // "uretim" uretilirdi.
  for (const host of ['oms-sit.example.com', 'hepsiburada.evil.com', 'api-sit.n11.com']) {
    const foreign = HB.resolveHepsiburadaHost({ host, environment: 'PRODUCTION' })
    assert.equal(foreign.ok, false, host)
    assert.equal(foreign.errorCode, 'HB_HOST_NOT_VERIFIED', host)
  }
})

test('HB-2: SIT host SIT olarak kalir, uretim host uretim sayilir', () => {
  const sit = HB.resolveHepsiburadaHost({ host: 'oms-external-sit.hepsiburada.com' })
  assert.equal(sit.environment, 'SIT')
  const prod = HB.resolveHepsiburadaHost({ host: 'oms-external.hepsiburada.com' })
  assert.equal(prod.environment, 'PRODUCTION')
  assert.equal(prod.host, 'oms-external.hepsiburada.com')
})

test('HB-3: bos host REDDEDILIR', () => {
  const empty = HB.resolveHepsiburadaHost({ host: '' })
  assert.equal(empty.ok, false)
  assert.equal(empty.errorCode, 'HB_HOST_EMPTY')
})

/* ═══════════════ HEPSIBURADA — BASIC AUTH ══════════════════════════ */

test('HB-4: Basic auth kurulur ve SIR SIZDIRMAZ', () => {
  const auth = HB.buildHepsiburadaAuth({
    merchantId: 'MERCHANT-1', username: 'devuser', password: 'sup3rs3cret',
  })
  assert.equal(auth.ok, true)
  assert.match(auth.headers.Authorization, /^Basic /)
  // Parola cozulebilir olmali (Basic sozlesmesi) ama DONEN NESNEDE ham
  // parola/kullanici alani BULUNMAMALI.
  const decoded = Buffer.from(
    auth.headers.Authorization.replace('Basic ', ''), 'base64',
  ).toString('utf8')
  assert.equal(decoded, 'devuser:sup3rs3cret')
  const serialized = JSON.stringify(auth)
  assert.equal(serialized.includes('sup3rs3cret'), false, 'parola sizdi')
  assert.equal(auth.maskedUsername, '***ser')
})

test('HB-5: eksik kimlik fail-closed', () => {
  for (const credentials of [
    { merchantId: 'M', username: 'u' },
    { merchantId: 'M', password: 'p' },
    { username: 'u', password: 'p' },
  ]) {
    const auth = HB.buildHepsiburadaAuth(credentials)
    assert.equal(auth.ok, false)
    assert.equal(auth.errorCode, 'HB_CREDENTIALS_INCOMPLETE')
    assert.deepEqual(auth.headers, {})
  }
})

/* ═══════════════ HEPSIBURADA — ORAN SINIRI ═════════════════════════ */

test('HB-6: 429 ve X-RateLimit-* basliklari OKUNUR', () => {
  const state = HB.readHepsiburadaRateState({
    family: 'ORDERS',
    statusCode: 429,
    headers: {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Limit': '100',
      'X-RateLimit-Reset': '30',
    },
  })
  assert.equal(state.rateLimited, true)
  assert.equal(state.remaining, 0)
  assert.equal(state.limit, 100)
  assert.equal(state.retryAfterMs, 30_000)
  assert.equal(state.family, 'ORDERS')
})

test('HB-7: baslik yoksa bekleme suresi UYDURULMAZ', () => {
  const state = HB.readHepsiburadaRateState({ family: 'LABELS', statusCode: 429 })
  assert.equal(state.rateLimited, true)
  assert.equal(state.retryAfterMs, null, 'sure uyduruldu')
  assert.equal(state.limit, null)
})

test('HB-8: limit TEK global sabit DEGIL, aile bazlidir', () => {
  const orders = HB.readHepsiburadaRateState({
    family: 'ORDERS', headers: { 'x-ratelimit-limit': '100' },
  })
  const labels = HB.readHepsiburadaRateState({
    family: 'LABELS', headers: { 'x-ratelimit-limit': '20' },
  })
  assert.equal(orders.limit, 100)
  assert.equal(labels.limit, 20)
  assert.notEqual(orders.family, labels.family)
})

/* ═══════════════ HEPSIBURADA — UÇ NOKTA UYDURULMAZ ═════════════════ */

test('HB-9: yol yapilandirilmadiysa istek KURULMAZ', () => {
  const missing = HB.buildHepsiburadaUrl({ host: 'oms-external-sit.hepsiburada.com' })
  assert.equal(missing.ok, false)
  assert.equal(missing.errorCode, 'HB_ENDPOINT_PATH_UNVERIFIED')

  const built = HB.buildHepsiburadaUrl({
    host: 'oms-external-sit.hepsiburada.com',
    path: '/orders/merchantid/MERCHANT-1',
    query: { offset: 0, limit: 50 },
  })
  assert.equal(built.ok, true)
  assert.match(built.url, /^https:\/\/oms-external-sit\.hepsiburada\.com\//)
  assert.match(built.url, /offset=0&limit=50/)
})

/* ═══════════════ HEPSIBURADA — SAYFALAMA / PENCERE ═════════════════ */

test('HB-10: offset/limit sayfalama (page DEGIL) ve limit kelepcesi', () => {
  const page = HBO.buildHepsiburadaPageRequest({
    offset: 50, limit: 5000, startMs: NOW - DAY, endMs: NOW,
  })
  assert.equal(page.offset, 50)
  assert.equal(page.limit, HBO.HEPSIBURADA_MAX_LIMIT)
  assert.equal(Object.prototype.hasOwnProperty.call(page, 'page'), false,
    'n11 sayfalamasi HBye sizdi')
  assert.match(page.begindate, /^\d{4}-\d{2}-\d{2}T/)
})

test('HB-11: paket penceresi 24 SAATE kelepcelenir', () => {
  const window = HBO.resolveHepsiburadaWindow({
    startMs: NOW - 10 * DAY, endMs: NOW, nowMs: NOW, family: 'PACKAGES',
  })
  assert.equal(window.ok, true)
  assert.equal(window.clamped, true)
  assert.equal(window.endMs - window.startMs, HBO.HEPSIBURADA_PACKAGE_WINDOW_MAX_MS)
})

test('HB-12: ters pencere REDDEDILIR', () => {
  const window = HBO.resolveHepsiburadaWindow({
    startMs: NOW, endMs: NOW - HOUR, nowMs: NOW,
  })
  assert.equal(window.ok, false)
  assert.equal(window.errorCode, 'HB_WINDOW_INVALID')
})

test('HB-13: sinirli cekim — eksik sayfa son sayfadir', () => {
  assert.equal(HBO.hasNextHepsiburadaPage({ returnedCount: 50, limit: 50 }), true)
  assert.equal(HBO.hasNextHepsiburadaPage({ returnedCount: 12, limit: 50 }), false)
  assert.equal(HBO.hasNextHepsiburadaPage({ returnedCount: 0, limit: 50 }), false)
})

/* ═══════════════ HEPSIBURADA — NORMALİZASYON ═══════════════════════ */

const hbRaw = {
  orderId: 'HB-ORDER-9001',
  orderNumber: 'HB-NUM-4471',
  packageNumber: 'HB-PKG-77',
  barcode: 'HBBARCODE-001',
  trackingInfoCode: 'HBTRACK-999',
  trackingInfoUrl: 'https://example.invalid/track',
  cargoCompany: 'HepsiJET',
  status: 'Open',
  merchantId: 'MERCHANT-1',
  orderDate: '2026-08-18T09:00:00Z',
  shippingAddress: { name: 'A B', city: 'İstanbul', district: 'Kadıköy' },
  items: [
    { lineItemId: 'HB-LINE-1', merchantSku: 'MSKU-1', hbSku: 'HBSKU-1', quantity: 2 },
  ],
}

test('HB-14: packageNumber orderNumberdan AYRI tutulur', () => {
  const order = HBO.normalizeHepsiburadaOrder(hbRaw)
  assert.equal(order.orderNumber, 'HB-NUM-4471')
  assert.equal(order.marketplacePackageId, 'HB-PKG-77')
  assert.notEqual(order.marketplacePackageId, order.orderNumber)
  // Paket YOKSA orderNumbera DUSULMEZ.
  const noPackage = HBO.normalizeHepsiburadaOrder({ ...hbRaw, packageNumber: '' })
  assert.equal(noPackage.marketplacePackageId, '')
})

test('HB-15: barcode ve trackingInfoCode AYRI alanlardir', () => {
  const order = HBO.normalizeHepsiburadaOrder(hbRaw)
  assert.equal(order.marketplaceBarcode, 'HBBARCODE-001')
  assert.equal(order.marketplaceTrackingNumber, 'HBTRACK-999')
  assert.notEqual(order.marketplaceBarcode, order.marketplaceTrackingNumber)
})

test('HB-16: kimlikler DIZE, sabit hane sayisi VARSAYILMAZ', () => {
  for (const packageNumber of ['7', '77777777777777777777', 'HB-PKG-77']) {
    const order = HBO.normalizeHepsiburadaOrder({ ...hbRaw, packageNumber })
    assert.equal(typeof order.marketplacePackageId, 'string')
    assert.equal(order.marketplacePackageId, packageNumber)
  }
})

test('HB-17: tasiyici kanonik anahtara eslenir, eslesmezse null', () => {
  assert.equal(HBO.mapHepsiburadaCarrier('HepsiJET'), 'hepsijet')
  assert.equal(HBO.mapHepsiburadaCarrier('Aras Kargo'), 'aras')
  assert.equal(HBO.mapHepsiburadaCarrier('Bilinmeyen Kargo A.S.'), null)
  const order = HBO.normalizeHepsiburadaOrder(hbRaw)
  assert.equal(order.marketplaceCarrier, 'hepsijet')
  assert.equal(order.rawCarrierName, 'HepsiJET')
})

test('HB-18: ham statu KORUNUR', () => {
  const order = HBO.normalizeHepsiburadaOrder(hbRaw)
  assert.equal(order.rawMarketplaceStatus, 'Open')
  assert.equal(order.rawOrder.status, 'Open')
})

/* ═══════════════ HEPSIBURADA — ORTAK BARKOD ════════════════════════ */

test('HB-19: ortak barkod YALNIZ dokumante tasiyicilarda acilir', () => {
  for (const carrier of ['hepsijet', 'aras']) {
    const capability = HBL.evaluateHepsiburadaLabelCapability({
      strategy: 'MARKETPLACE_MANAGED_LABEL', carrier, outputFormat: 'zpl',
    })
    assert.equal(capability.ok, true, carrier)
    assert.equal(capability.supportedCarrier, true, carrier)
  }
  for (const carrier of ['surat', 'yurtici', 'mng', 'ptt', '']) {
    const capability = HBL.evaluateHepsiburadaLabelCapability({
      strategy: 'MARKETPLACE_MANAGED_LABEL', carrier, outputFormat: 'zpl',
    })
    assert.equal(capability.ok, false, carrier)
    assert.equal(capability.errorCode, 'HB_MUTUAL_BARCODE_CARRIER_UNSUPPORTED', carrier)
  }
})

test('HB-20: dokumante OLMAYAN cikti bicimi REDDEDILIR', () => {
  const bad = HBL.evaluateHepsiburadaLabelCapability({
    strategy: 'MARKETPLACE_MANAGED_LABEL', carrier: 'aras', outputFormat: 'svg',
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.errorCode, 'HB_MUTUAL_BARCODE_FORMAT_UNSUPPORTED')
  for (const format of HBL.HEPSIBURADA_MUTUAL_BARCODE_FORMATS) {
    const good = HBL.evaluateHepsiburadaLabelCapability({
      strategy: 'MARKETPLACE_MANAGED_LABEL', carrier: 'aras', outputFormat: format,
    })
    assert.equal(good.ok, true, format)
  }
})

test('HB-21: 101/102/400/500 GENEL BASARI sayilmaz', () => {
  const capability = HBL.evaluateHepsiburadaLabelCapability({
    strategy: 'MARKETPLACE_MANAGED_LABEL', carrier: 'aras', outputFormat: 'zpl',
  })
  for (const [businessCode, expected] of [
    [101, 'HB_MUTUAL_BARCODE_CARRIER_NO_BARCODE'],
    [102, 'HB_MUTUAL_BARCODE_MERCHANT_NOT_ACTIVE'],
    [400, 'HB_MUTUAL_BARCODE_CARRIER_UNSUPPORTED'],
    [500, 'HB_MUTUAL_BARCODE_INTERNAL_ERROR'],
  ]) {
    const result = HBL.classifyHepsiburadaBarcodeResponse({
      capability,
      statusCode: 200, // HTTP 200 TEK BASINA yeterli DEGIL
      businessCode,
      label: '^XA^XZ',
    })
    assert.equal(result.ok, false, String(businessCode))
    assert.equal(result.errorCode, expected, String(businessCode))
  }
})

test('HB-22: artefakt YOKSA basari sayilmaz', () => {
  const capability = HBL.evaluateHepsiburadaLabelCapability({
    strategy: 'MARKETPLACE_MANAGED_LABEL', carrier: 'aras', outputFormat: 'zpl',
  })
  const empty = HBL.classifyHepsiburadaBarcodeResponse({
    capability, statusCode: 200, businessCode: null,
  })
  assert.equal(empty.ok, false)
  assert.equal(empty.errorCode, 'HB_MUTUAL_BARCODE_ARTIFACT_MISSING')

  const good = HBL.classifyHepsiburadaBarcodeResponse({
    capability, statusCode: 200, businessCode: null, label: '^XA^XZ',
  })
  assert.equal(good.ok, true)
  assert.equal(good.artifactPresent, true)
})

test('HB-23: pazaryeri yonetimli etiket DOGRUDAN ARAS yolundan AYRIDIR', () => {
  // Ayni tasiyici (aras) icin bile strateji acikca secilmelidir.
  const direct = HBL.evaluateHepsiburadaLabelCapability({
    strategy: 'DIRECT_CARRIER_LABEL', carrier: 'aras', outputFormat: 'zpl',
  })
  assert.equal(direct.ok, false)
  assert.equal(direct.errorCode, 'HB_LABEL_STRATEGY_NOT_MARKETPLACE_MANAGED')
  assert.equal(direct.strategy, 'DIRECT_CARRIER_LABEL')

  // Strateji HIC verilmezse de sessizce pazaryeri yoluna DUSMEZ.
  const unset = HBL.evaluateHepsiburadaLabelCapability({
    carrier: 'aras', outputFormat: 'zpl',
  })
  assert.equal(unset.ok, false)
})

/* ═══════════════ N11 — KİMLİK / SÖZLEŞME ═══════════════════════════ */

test('N11-1: appkey/appsecret BASLIK olarak gider, Authorization YOK', () => {
  const auth = N11.buildN11AuthHeaders({ appKey: 'AK-123', appSecret: 'AS-456' })
  assert.equal(auth.ok, true)
  assert.equal(auth.headers.appkey, 'AK-123')
  assert.equal(auth.headers.appsecret, 'AS-456')
  assert.equal(
    Object.prototype.hasOwnProperty.call(auth.headers, 'Authorization'), false,
    'n11 Authorization semasi KULLANMAZ',
  )
  assert.equal(auth.maskedAppKey, '***123')
})

test('N11-2: eksik kimlik fail-closed', () => {
  for (const credentials of [{ appKey: 'AK' }, { appSecret: 'AS' }, {}]) {
    const auth = N11.buildN11AuthHeaders(credentials)
    assert.equal(auth.ok, false)
    assert.equal(auth.errorCode, 'N11_CREDENTIALS_INCOMPLETE')
    assert.deepEqual(auth.headers, {})
  }
})

test('N11-3: resmi uc nokta ve servis limiti sabitleri', () => {
  assert.equal(
    N11.N11_SHIPMENT_PACKAGES_URL,
    'https://api.n11.com/rest/delivery/v1/shipmentPackages',
  )
  assert.equal(N11.N11_RATE_LIMIT_PER_MINUTE, 1000)
  assert.equal(N11.N11_MAX_PAGE_SIZE, 100)
  assert.equal(N11.N11_FIRST_PAGE, 0)
})

/* ═══════════════ N11 — SAYFALAMA / PENCERE ═════════════════════════ */

test('N11-4: sayfa 0 tabanli, size 100e kelepcelenir', () => {
  const first = N11.buildN11PageRequest({})
  assert.equal(first.page, 0)
  assert.equal(first.size, 100)
  const clamped = N11.buildN11PageRequest({ page: 3, size: 5000 })
  assert.equal(clamped.size, 100)
  assert.equal(clamped.page, 3)
  // Hepsiburada offset semantigi n11e SIZMAZ.
  assert.equal(Object.prototype.hasOwnProperty.call(first, 'offset'), false)
})

test('N11-5: artimli sorgu lastModifiedDate ve ASC kullanir', () => {
  const incremental = N11.buildN11PageRequest({ incremental: true })
  assert.equal(incremental.orderByField, 'true')
  assert.equal(incremental.orderByDirection, 'ASC')
  const plain = N11.buildN11PageRequest({})
  assert.equal(plain.orderByField, undefined)
})

test('N11-6: 15 gunluk pencere kurallari UYGULANIR', () => {
  // Yalniz startDate → SONRAKI 15 gun.
  const startOnly = N11.resolveN11Window({ startMs: NOW, nowMs: NOW })
  assert.equal(startOnly.mode, 'START_ONLY')
  assert.equal(startOnly.endMs - startOnly.startMs, N11.N11_WINDOW_MS)
  assert.equal(startOnly.startMs, NOW)

  // Yalniz endDate → ONCEKI 15 gun.
  const endOnly = N11.resolveN11Window({ endMs: NOW, nowMs: NOW })
  assert.equal(endOnly.mode, 'END_ONLY')
  assert.equal(endOnly.endMs, NOW)
  assert.equal(endOnly.endMs - endOnly.startMs, N11.N11_WINDOW_MS)
})

test('N11-7: asiri genis aralik SON 15 gune indirgenir', () => {
  const wide = N11.resolveN11Window({
    startMs: NOW - 90 * DAY, endMs: NOW, nowMs: NOW,
  })
  assert.equal(wide.ok, true)
  assert.equal(wide.clamped, true)
  assert.equal(wide.mode, 'CLAMPED_TO_LAST_WINDOW')
  assert.equal(wide.endMs - wide.startMs, N11.N11_WINDOW_MS)
  assert.equal(wide.endMs, NOW)
})

test('N11-8: ters pencere REDDEDILIR', () => {
  const bad = N11.resolveN11Window({ startMs: NOW, endMs: NOW - DAY, nowMs: NOW })
  assert.equal(bad.ok, false)
  assert.equal(bad.errorCode, 'N11_WINDOW_INVALID')
})

test('N11-9: sonraki sayfa totalPages VE icerik ile belirlenir', () => {
  assert.equal(N11.hasNextN11Page({ page: 0, totalPages: 3, returnedCount: 100 }), true)
  assert.equal(N11.hasNextN11Page({ page: 2, totalPages: 3, returnedCount: 100 }), false)
  // Bos icerik SONLANDIRIR (resmi yonlendirme).
  assert.equal(N11.hasNextN11Page({ page: 0, totalPages: 9, returnedCount: 0 }), false)
  // totalPages hic gelmezse sonsuz donguye GIRILMEZ.
  assert.equal(N11.hasNextN11Page({ page: 0, returnedCount: 100 }), false)
})

test('N11-10: COK STATU = COK ISTEK (virgulle birlestirilmez)', () => {
  const plan = N11.planN11StatusRequests(['Created', 'Picking', 'Created', 'Bilinmeyen'])
  assert.deepEqual(plan, ['Created', 'Picking'])
  for (const status of plan) {
    const request = N11.buildN11PageRequest({ status })
    assert.equal(request.status, status)
    assert.equal(String(request.status).includes(','), false, 'statu birlestirildi')
  }
})

/* ═══════════════ N11 — NORMALİZASYON ═══════════════════════════════ */

const n11Raw = {
  id: 'N11-PKG-5150',
  orderNumber: 'N11-ORDER-880',
  cargoSenderNumber: 'N11TRACK-4444',
  cargoTrackingNumber: 'N11BARCODE-8888',
  cargoTrackingLink: 'https://example.invalid/n11track',
  shipmentCompanyId: '39',
  cargoProviderName: 'Aras Kargo',
  lastModifiedDate: '2026-08-19T08:30:00Z',
  sellerId: 'SELLER-7',
  status: 'Picking',
  shippingAddress: { city: 'Ankara', district: 'Çankaya' },
  billingAddress: { city: 'Ankara' },
  lines: [{ orderLineId: 'N11-LINE-1', productName: 'Ürün A', quantity: 3 }],
  packageHistories: [{ createdDate: '2026-08-19T08:00:00Z', status: 'Created' }],
}

test('N11-11: cargoSenderNumber TAKIP, cargoTrackingNumber BARKODdur', () => {
  const order = N11O.normalizeN11Order(n11Raw)
  // Bu iki satir bilerek "ters" gorunur; resmi anlamlar boyledir.
  assert.equal(order.marketplaceTrackingNumber, 'N11TRACK-4444')
  assert.equal(order.marketplaceBarcode, 'N11BARCODE-8888')
  // IKISI DE korunur ve BIRBIRINE esit degildir.
  assert.notEqual(order.marketplaceTrackingNumber, order.marketplaceBarcode)
})

test('N11-12: id PAKET kimligidir, orderNumber AYRIDIR', () => {
  const order = N11O.normalizeN11Order(n11Raw)
  assert.equal(order.marketplacePackageId, 'N11-PKG-5150')
  assert.equal(order.orderNumber, 'N11-ORDER-880')
  assert.notEqual(order.marketplacePackageId, order.orderNumber)
})

test('N11-13: kimlikler sabit hane sayisina BAGLI DEGIL', () => {
  for (const id of ['5', '515051505150515051', 'N11-PKG-5150']) {
    const order = N11O.normalizeN11Order({ ...n11Raw, id })
    assert.equal(typeof order.marketplacePackageId, 'string')
    assert.equal(order.marketplacePackageId, id)
  }
})

test('N11-14: ham statu KORUNUR ve Trendyol sozlugu KULLANILMAZ', () => {
  const order = N11O.normalizeN11Order(n11Raw)
  assert.equal(order.rawMarketplaceStatus, 'Picking')
  assert.equal(order.operationStatus, 'PICKING')
  // Bilinmeyen statu sessizce "Yeni"ye DUSMEZ.
  const unknown = N11O.normalizeN11Order({ ...n11Raw, status: 'Awaiting' })
  assert.equal(unknown.operationStatus, null)
  assert.equal(unknown.rawMarketplaceStatus, 'Awaiting')
})

test('N11-15: resmi statu kumesi eslenir', () => {
  const expected = {
    Created: 'NEW', Picking: 'PICKING', Shipped: 'SHIPPED',
    Delivered: 'DELIVERED', Cancelled: 'CANCELLED',
    Unpacked: 'CANCELLED', UnSupplied: 'CANCELLED',
  }
  for (const status of N11.N11_PACKAGE_STATUSES) {
    assert.equal(N11O.mapN11StatusToOperation(status), expected[status], status)
  }
})

test('N11-16: artimli imlec adayi en guncel lastModifiedDate', () => {
  const { orders } = N11O.normalizeN11Orders([
    n11Raw,
    { ...n11Raw, id: 'N11-PKG-2', lastModifiedDate: '2026-08-19T10:00:00Z' },
  ])
  const candidate = N11O.resolveN11CandidateCheckpointMs(orders)
  assert.equal(candidate, Date.parse('2026-08-19T10:00:00Z'))
})

/* ═══════════════ N11 — YAZMA KAPALI ════════════════════════════════ */

test('N11-17: pazaryeri yazmalari KAPALI', () => {
  assert.equal(SEAM.marketplaceWritesEnabled, false)
  // Guncelleme ucu TANIMLI ama bu testte KULLANILMAZ; taniml olmasi yeter.
  assert.equal(N11.N11_ORDER_UPDATE_URL, 'https://api.n11.com/rest/order/v1/update')
})

/* ═══════════════ SAĞLAYICILAR ARASI ════════════════════════════════ */

test('X-1: ayni siparis numarasi FARKLI pazaryerlerinde CAKISMAZ', () => {
  const shared = 'ORDER-1000'
  const hb = SEAM.marketplaceScopeKey({
    providerKey: 'hepsiburada', marketplaceAccountId: 'acct-1',
    marketplacePackageId: shared,
  })
  const n11 = SEAM.marketplaceScopeKey({
    providerKey: 'n11', marketplaceAccountId: 'acct-1',
    marketplacePackageId: shared,
  })
  const trendyol = SEAM.marketplaceScopeKey({
    providerKey: 'trendyol', marketplaceAccountId: 'acct-1',
    marketplacePackageId: shared,
  })
  assert.equal(new Set([hb, n11, trendyol]).size, 3, 'saglayicilar CAKISTI')
})

test('X-2: paket kimligi HESAP kapsamindadir', () => {
  const a = SEAM.marketplaceScopeKey({
    providerKey: 'n11', marketplaceAccountId: 'acct-A', marketplacePackageId: 'P1',
  })
  const b = SEAM.marketplaceScopeKey({
    providerKey: 'n11', marketplaceAccountId: 'acct-B', marketplacePackageId: 'P1',
  })
  assert.notEqual(a, b, 'hesap izolasyonu YOK')
})

test('X-3: saglayici anahtari TAM eslesir (fuzzy YOK)', () => {
  assert.deepEqual(
    [...SEAM.MARKETPLACE_PROVIDER_KEYS], ['trendyol', 'hepsiburada', 'n11'],
  )
  const upper = SEAM.marketplaceScopeKey({
    providerKey: 'N11', marketplacePackageId: 'P1',
  })
  const lower = SEAM.marketplaceScopeKey({
    providerKey: 'n11', marketplacePackageId: 'P1',
  })
  assert.equal(upper, lower, 'kanonik anahtar normalize edilmeli')
})

test('X-4: iki saglayici da BIRBIRININ sayfalama semantigini kullanmaz', () => {
  const hbPage = HBO.buildHepsiburadaPageRequest({ startMs: NOW - DAY, endMs: NOW })
  const n11Page = N11.buildN11PageRequest({})
  assert.equal(typeof hbPage.offset, 'number')
  assert.equal(hbPage.page, undefined)
  assert.equal(typeof n11Page.page, 'number')
  assert.equal(n11Page.offset, undefined)
})

/* ═══════════════ KİMLİK DEPOLAMA (şifreli, sızıntısız) ═════════════ */

test('X-5: yeni saglayicilar kimlik deposunda TANIMLI', async () => {
  const service = await import('./integrations/credentialService.ts')
  for (const provider of ['trendyol', 'surat', 'hepsiburada', 'n11']) {
    assert.ok(
      service.INTEGRATION_PROVIDERS.includes(provider),
      `${provider} kimlik deposunda yok`,
    )
  }
})

test('X-6: DB allowlist migration ile GENISLETILDI', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))

  const schema = readFileSync(join(here, 'db', 'schema.ts'), 'utf8')
  assert.match(schema, /'trendyol', 'surat', 'hepsiburada', 'n11'/)

  // Migration DOSYASI var (uretimde CALISTIRILMAZ; bu yalniz sema kaynagi).
  const files = readdirSync(join(here, '..', 'drizzle'))
    .filter((name) => name.endsWith('.sql'))
  const allowlist = files.filter((name) => {
    const body = readFileSync(join(here, '..', 'drizzle', name), 'utf8')
    return body.includes('integration_credentials_provider_check')
      && body.includes('hepsiburada')
  })
  assert.equal(allowlist.length, 1, 'allowlist migrationi tam olarak bir kez olmali')
})

test('X-7: saglayiciya OZEL kimlik alanlari normallestirilmis siparise SIZMAZ', () => {
  const hbOrder = HBO.normalizeHepsiburadaOrder(hbRaw)
  const n11Order = N11O.normalizeN11Order(n11Raw)
  const forbidden = /password|appsecret|apisecret|authorization|basic /i
  for (const [name, order] of [['HB', hbOrder], ['N11', n11Order]]) {
    assert.equal(
      forbidden.test(JSON.stringify(order)), false,
      `${name}: kimlik alani normallestirilmis siparise sizdi`,
    )
  }
  // merchantId TICARI kimliktir, SIR DEGILDIR — HB tarafinda tasinabilir.
  assert.equal(hbOrder.merchantId, 'MERCHANT-1')
})
