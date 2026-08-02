// /api/orders sayfalama sözleşmesi ve anlık-görüntü (snapshot) doğrulaması.
//
// SAF modül: fetch/DOM/IO YOKTUR, bu yüzden doğrudan test edilebilir.
//
// SÖZLEŞME (server/index.mjs + server/orders/orderRepository.ts):
//   istek : ?page=<1-tabanlı>&pageSize=<1..100>
//   yanıt : { ok, orders, total, page, pageSize }
//   total = FİLTREYE UYAN SATIR SAYISI (count(*)), sayfa sınırından bağımsız.
//   totalPages DÖNDÜRÜLMEZ → ceil(total / pageSize) ile türetilir.
//
// `total` SATIR sayısıdır, "distinct paket" sayısı DEĞİL. Ancak orders
// tablosunda unique index (organization_id, marketplace, marketplace_account_id,
// package_id) vardır ve endpoint org + hesap kapsamında sorgular; dedupe anahtarı
// da `${marketplace}:package:${packageId}`'dir. Dolayısıyla TEK bir istek
// kapsamında satır sayısı ile distinct kimlik sayısı EŞİTTİR. Bu yüzden
// "dedupe hiçbir şeyi düşürmemeli" invaryantı geçerlidir; dedupe bir kayıt
// düşürdüyse sayfalar arasında kayıt kümesi KAYMIŞ demektir.
export const ORDERS_BACKEND_MAX_PAGE_SIZE = 100

export const ORDERS_SNAPSHOT_CHANGED_MESSAGE =
  'Sipariş listesi yüklenirken kayıt kümesi değişti; yeniden deneyin.'

export interface OrderPageResponseMeta {
  orderCount: number
  total: number
  page: number
  pageSize: number
}

export interface ExpectedPageShape {
  page: number
  pageSize: number
  /** İlk sayfadan gelen referans total (sonraki sayfalarda değişmemeli). */
  expectedTotal: number
  totalPages: number
}

export function resolveTotalPages(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(
      'Siparişler yüklenemedi: sunucu geçersiz toplam kayıt sayısı bildirdi.',
    )
  }
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new Error(
      'Siparişler yüklenemedi: sunucu geçersiz sayfa boyutu bildirdi.',
    )
  }
  return total === 0 ? 1 : Math.ceil(total / pageSize)
}

// Tek bir sayfa yanıtının metadata'sını doğrular. Tutarsızlık SESSİZCE
// başarı sayılmaz; açık hata fırlatılır.
export function validateOrderPageMeta(
  meta: OrderPageResponseMeta,
  expected: ExpectedPageShape,
): void {
  // 1) Dönen sayfa numarası istenen sayfa ile eşleşmeli (yanlış sayfa =
  //    sessiz veri kaybı riski).
  if (meta.page !== expected.page) {
    throw new Error(
      `Siparişler yüklenemedi: sunucu ${expected.page}. sayfa yerine ` +
        `${meta.page}. sayfayı döndürdü.`,
    )
  }
  // 2) Sayfa boyutu pozitif ve backend maksimumunu aşmamalı.
  if (
    !Number.isFinite(meta.pageSize) ||
    meta.pageSize <= 0 ||
    meta.pageSize > ORDERS_BACKEND_MAX_PAGE_SIZE
  ) {
    throw new Error(
      `Siparişler yüklenemedi: sunucu geçersiz sayfa boyutu bildirdi ` +
        `(${meta.pageSize}).`,
    )
  }
  // 3) total sayfalar arasında DEĞİŞMEMELİ. Değiştiyse kayıt kümesi kaydı;
  //    kısmi/karışık liste "başarılı" sayılmaz.
  if (meta.total !== expected.expectedTotal) {
    throw new Error(ORDERS_SNAPSHOT_CHANGED_MESSAGE)
  }
  // 4) Sayfadaki kayıt sayısı beklenen aralıkta olmalı. Son sayfa kısmi
  //    olabilir; diğer sayfalar TAM dolu olmalıdır.
  const isLastPage = expected.page === expected.totalPages
  const expectedOnLastPage =
    expected.expectedTotal - (expected.totalPages - 1) * expected.pageSize
  const expectedCount = isLastPage
    ? Math.max(0, expectedOnLastPage)
    : expected.pageSize
  if (meta.orderCount > expected.pageSize) {
    throw new Error(
      'Siparişler yüklenemedi: sunucu sayfa boyutundan fazla kayıt döndürdü.',
    )
  }
  if (meta.orderCount !== expectedCount) {
    // Beklenenden az/çok kayıt: sayfalama penceresi kaymış olabilir.
    throw new Error(ORDERS_SNAPSHOT_CHANGED_MESSAGE)
  }
}

// Tüm sayfalar toplandıktan SONRAKİ bütünlük kontrolü.
// - toplanan satır sayısı total ile eşleşmeli
// - canonical dedupe HİÇBİR kaydı düşürmemeli (bkz. yukarıdaki unique index
//   gerekçesi); düşürdüyse sayfalar arasında kayıt tekrar etmiş, yani pencere
//   kaymıştır.
export function validatePaginationSnapshot(input: {
  collectedRowCount: number
  distinctCount: number
  expectedTotal: number
}): void {
  if (input.collectedRowCount !== input.expectedTotal) {
    throw new Error(ORDERS_SNAPSHOT_CHANGED_MESSAGE)
  }
  if (input.distinctCount !== input.collectedRowCount) {
    throw new Error(ORDERS_SNAPSHOT_CHANGED_MESSAGE)
  }
}
