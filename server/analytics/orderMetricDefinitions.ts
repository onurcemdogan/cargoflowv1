// CANONICAL Dashboard satış/iade metrik tanımları (tek kaynak). Local-only
// Dashboard ile referans (Trendyol) Dashboard arasındaki karşılaştırmalarda
// tanım belirsizliğini ortadan kaldırır. Provider'a çıkmaz; yalnız tanım/sabit.
//
// NOT: Bu modül TANIMLARI açıkça belgeler. Rakamları referans Dashboard'a
// ZORLA eşitlemek için formül değiştirilmez; fark tanım farkıysa raporlanır.

// PAKET: benzersiz sevkiyat/operasyon birimi = distinct packageId
// (yoksa shipmentPackageId, yoksa marketplace::orderNumber). Bir Trendyol
// siparişi birden çok pakete bölünebilir; her paket bir operasyon birimidir.
export const METRIC_PACKAGE = 'distinct_package_id'

// KALEM (line): order_lines SATIR SAYISI (distinct order line), quantity toplamı
// DEĞİL. "Kalem 285" = 285 sipariş satırı. (quantity toplamı ayrı bir metriktir:
// METRIC_UNIT_QUANTITY.)
export const METRIC_LINE = 'order_line_count'

// ÜRÜN ADEDİ (quantity): order_lines quantity TOPLAMI (kaç adet ürün satıldı).
export const METRIC_UNIT_QUANTITY = 'order_line_quantity_sum'

// SATIŞ (gross): kapsamdaki TÜM siparişlerin totalAmount toplamı (statü
// ayırt etmeden). İptal/iade AYRI gösterilir; brüt satıştan otomatik
// DÜŞÜLMEZ (net ayrı hesaplanır). Referans Dashboard net gösteriyorsa fark
// buradan gelebilir.
export const METRIC_SALES_GROSS = 'sum_total_amount_all_status'

// İPTAL tutarı: marketplaceStatus = 'Cancelled' siparişlerin totalAmount toplamı.
export const CANCEL_STATUSES = ['Cancelled'] as const

// İADE tutarı — İKİ kaynak (bkz. dashboardViewModel.refundDataSource):
//   persisted_claims: gerçek claim muhasebesi (claim effectiveDate + kısmi tutar)
//   order_status: marketplaceStatus = 'Returned' siparişlerin totalAmount toplamı
//   unavailable: hesaplanacak yerel veri yok
// Auth modunda claim tablosu olmadığından order_status kullanılır (yalnız Returned
// statülü siparişlerin tam tutarı; kısmi iade tutarı YOKTUR).
export const RETURN_STATUSES = ['Returned'] as const

// NET SATIŞ: gross - (iptal + iade). Local-only Dashboard iptal/iadeyi statüden
// türetir; kısmi claim tutarı olmadığından net, referans (claim-tabanlı) net'ten
// SAPABİLİR. Fark tanım/veri farkıdır, formül farkı değildir.
export const NET_SALES_FORMULA = 'gross - (cancel_amount + return_amount)'

// ANALİTİĞE DAHİL STATÜLER: local-only Dashboard kapsamdaki TÜM statüleri dahil
// eder (client viewModel statüye göre sınıflandırır). Operasyonel sync yalnız
// aktif statüleri (Created/Picking/Invoiced) ~10 günlük pencerede persist eder;
// bu yüzden Delivered/Shipped/Cancelled/Returned ve eski tarihli siparişler
// backfill edilene kadar yerel DB'de EKSİK kalır (kök neden).
export const ANALYTICS_STATUSES = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'Delivered',
  'AtCollectionPoint',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
] as const

export interface CanonicalMetricSummary {
  packageCount: number
  lineCount: number
  unitQuantity: number
  grossSales: number
  cancelAmount: number
  returnAmount: number
  netSales: number
}

// Yerel mutabakat aggregate'inden canonical metrik özeti üretir (pure).
export function toCanonicalSummary(input: {
  distinctPackageIds: number
  orderLineCount: number
  lineQuantityTotal: number
  totalAmount: number
  byMarketplaceStatus: { key: string; count: number; amount: number }[]
}): CanonicalMetricSummary {
  const amountForStatuses = (statuses: readonly string[]) =>
    input.byMarketplaceStatus
      .filter((row) => statuses.includes(row.key))
      .reduce((sum, row) => sum + row.amount, 0)
  const cancelAmount = amountForStatuses(CANCEL_STATUSES)
  const returnAmount = amountForStatuses(RETURN_STATUSES)
  return {
    packageCount: input.distinctPackageIds,
    lineCount: input.orderLineCount,
    unitQuantity: input.lineQuantityTotal,
    grossSales: input.totalAmount,
    cancelAmount,
    returnAmount,
    netSales: input.totalAmount - (cancelAmount + returnAmount),
  }
}
