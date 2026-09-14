// TRENDYOL ORDER V2 — ÇEVRİMDIŞI FIXTURE'LAR.
//
// KAYNAK: developers.trendyol.com "Sipariş Paketlerini Çekme
// (getShipmentPackages)" resmî örnek yanıtı ve resmî cap açıklaması
// (sayfa güncellemesi 2026-09-09). Alınma: 2026-09-14.
//
// CANLI SAĞLAYICI ÇAĞRISI YOK. Buradaki her gövde resmî örneğin şeklini
// taşır; alan UYDURULMAZ. Müşteri verisi TEMSİLÎDİR (resmî dokümandaki
// "John Doe" örneğiyle aynı), gerçek kişi verisi İÇERMEZ.

export const FIXTURE_META = {
  source:
    'https://developers.trendyol.com/docs/sipariş-paketlerini-çekme-getshipmentpackages',
  retrievedAt: '2026-09-14',
  apiVersion: 'v2',
  official: true,
}

/** Resmî örnekten türetilmiş tek paket. */
export function packageFixture(overrides = {}) {
  return {
    shipmentAddress: {
      id: 11111111,
      firstName: 'John',
      lastName: 'Doe',
      company: '',
      address1: "John Doe's House",
      address2: "John Doe's House",
      city: 'İstanbul',
      cityCode: 34,
      district: 'Sarıyer',
      districtId: 54,
      postalCode: '34200',
      countryCode: 'TR',
      neighborhoodId: 21111,
      neighborhood: 'Maslak Mahallesi',
      phone: '333333333',
      fullAddress: "John Doe's House",
      fullName: 'John Doe',
    },
    orderNumber: '1234567890',
    id: 3330111111,
    shipmentPackageId: 3330111111,
    status: 'Created',
    shipmentPackageStatus: 'Created',
    customerFirstName: 'John',
    customerLastName: 'Doe',
    customerEmail: 'john@example.invalid',
    grossAmount: 301.4,
    totalPrice: 301.4,
    currencyCode: 'TRY',
    orderDate: 1_757_000_000_000,
    lastModifiedDate: 1_757_100_000_000,
    deci: 2,
    cargoDeci: 10,
    cargoProviderName: 'Aras Kargo',
    cargoProviderId: 7,
    cargoTrackingNumber: '7260000167037306',
    cargoTrackingLink: 'https://tracking.trendyol.com/?id=1111',
    cargoSenderNumber: '210090111111',
    commercial: false,
    micro: false,
    is4P: false,
    createdBy: 'order-creation',
    lines: [
      {
        id: 987654321,
        quantity: 1,
        productName: 'Kuş ve Çiçek Desenli Tepsi',
        barcode: 'BRC0001',
        stockCode: '111111',
        merchantSku: '111111',
        productCode: 55555,
        price: 301.4,
        amount: 301.4,
      },
    ],
    ...overrides,
  }
}

const envelope = (content, totalElements, page = 0, size = 200) => ({
  totalElements,
  totalPages: Math.max(1, Math.ceil(totalElements / size)),
  page,
  size,
  content,
})

/** V2-ORDERS-1 — normal sayfa. */
export const V2_ORDERS_1_NORMAL_PAGE = envelope([packageFixture()], 1, 0, 200)

/** V2-ORDERS-2 — boş sonuç. */
export const V2_ORDERS_2_EMPTY = envelope([], 0, 0, 200)

/** V2-ORDERS-3 — çok sayfalı (3 sayfa, size=200). */
export const V2_ORDERS_3_MULTI_PAGE = {
  totalElements: 450,
  totalPages: 3,
  size: 200,
  pages: [
    envelope(
      Array.from({ length: 200 }, (_, i) =>
        packageFixture({ id: 4000000 + i, shipmentPackageId: 4000000 + i }),
      ),
      450,
      0,
      200,
    ),
    envelope(
      Array.from({ length: 200 }, (_, i) =>
        packageFixture({ id: 4000200 + i, shipmentPackageId: 4000200 + i }),
      ),
      450,
      1,
      200,
    ),
    envelope(
      Array.from({ length: 50 }, (_, i) =>
        packageFixture({ id: 4000400 + i, shipmentPackageId: 4000400 + i }),
      ),
      450,
      2,
      200,
    ),
  ],
}

/**
 * V2-ORDERS-4 — 10k cap sınırı.
 *
 * Resmî örnek birebir: totalElements 12.540, totalPages 63 GÖRÜNÜR ama
 * yalnız ilk 10.000 kayıt erişilebilirdir.
 */
export const V2_ORDERS_4_CAP_BOUNDARY = {
  totalElements: 12540,
  totalPages: 63,
  page: 0,
  size: 200,
  content: [packageFixture()],
}

/** V2-ORDERS-5 — dokümante edilmemiş statü. */
export const V2_ORDERS_5_UNKNOWN_STATUS = envelope(
  [packageFixture({ status: 'SomeFutureStatus', shipmentPackageStatus: 'SomeFutureStatus' })],
  1,
  0,
  200,
)

/** V2-ORDERS-6 — bozuk gövde (content dizi değil). */
export const V2_ORDERS_6_MALFORMED = { totalElements: 'çok', content: { nope: true } }

/** V2-ORDERS-7 — kimlik doğrulama hataları. */
export const V2_ORDERS_7_UNAUTHORIZED = {
  statusCode: 401,
  body: { exception: 'ClientApiAuthenticationException', message: 'Unauthorized' },
}
export const V2_ORDERS_7_FORBIDDEN = {
  statusCode: 403,
  body: { message: 'User-Agent header is required' },
}

/** V2-ORDERS-8 — oran sınırı. */
export const V2_ORDERS_8_RATE_LIMITED = {
  statusCode: 429,
  body: { message: 'too.many.requests' },
}

/** V2-ORDERS-9 — EMEKLİ uçtan dönen geçiş kodu. */
export const V2_ORDERS_9_DEPRECATED_426 = {
  statusCode: 426,
  body: {
    message:
      'This endpoint is deprecated. Please migrate to /v2/orders before 2026-10-15.',
  },
}
