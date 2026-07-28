// Server-tarafı Dashboard satış AMOUNT-BUCKET yardımcısı (diagnostic mutabakatı).
// TEK KAYNAK tanım (date basis, disposition token'ları, kimlikler, etiketler)
// src/dashboard/dashboardSalesMetricDefinition.ts'tedir; bu modül o kimlik
// sabitlerini RE-EXPORT eder (kavram üç yerde AYRI tanımlanmasın) ve yalnızca
// STATÜ-BUCKET tutar toplamı (Cancelled/Returned) mantığını ekler.
//
// NOT: Bu modül TANIMLARI açıkça belgeler. Rakamları referans Dashboard'a
// ZORLA eşitlemek için formül değiştirilmez; fark tanım farkıysa raporlanır.
import {
  ACTIVITY_DATE_BASIS_LABEL,
  AMOUNT_SOURCE,
  classifyCanonicalDisposition,
  describeSalesMetric,
  HISTORICAL_ACTIVITY_BASIS,
  METRIC_LINE,
  METRIC_PACKAGE,
  METRIC_UNIT_QUANTITY,
  SALES_DATE_BASIS,
  SALES_DATE_BASIS_LABEL,
} from '../../src/dashboard/dashboardSalesMetricDefinition.ts'

// PAKET / KALEM / ÜRÜN ADEDİ kimlikleri canonical modülden gelir (tek kaynak).
//   PAKET       = distinct packageId (bir sipariş çok pakete bölünebilir)
//   KALEM       = order_lines satır sayısı (quantity toplamı DEĞİL)
//   ÜRÜN ADEDİ  = order_lines quantity toplamı
export {
  ACTIVITY_DATE_BASIS_LABEL,
  AMOUNT_SOURCE,
  describeSalesMetric,
  HISTORICAL_ACTIVITY_BASIS,
  METRIC_LINE,
  METRIC_PACKAGE,
  METRIC_UNIT_QUANTITY,
  SALES_DATE_BASIS,
  SALES_DATE_BASIS_LABEL,
}

// SATIŞ (gross): kapsamdaki TÜM siparişlerin totalAmount toplamı (statü
// ayırt etmeden). İptal/iade AYRI gösterilir; brüt satıştan otomatik
// DÜŞÜLMEZ (net ayrı hesaplanır). Referans Dashboard net gösteriyorsa fark
// buradan gelebilir.
export const METRIC_SALES_GROSS = 'sum_total_amount_all_status'

// İPTAL statüleri (canonical disposition ile AYNI): Cancelled + UnSupplied.
// (Bilgilendirme sabiti; tutar ayrıştırması classifyCanonicalDisposition ile
// yapılır — Dashboard ile tek kaynak.)
export const CANCEL_STATUSES = ['Cancelled', 'UnSupplied'] as const

// İADE statüleri (canonical disposition ile AYNI): Returned + UnDelivered.
//   İade tutarı kaynağı (bkz. dashboardViewModel.refundDataSource):
//   persisted_claims: gerçek claim muhasebesi (claim effectiveDate + kısmi tutar)
//   order_status: Returned/UnDelivered siparişlerin totalAmount toplamı
//   unavailable: hesaplanacak yerel veri yok
// Auth modunda claim tablosu olmadığından order_status kullanılır (kısmi iade
// tutarı YOKTUR).
export const RETURN_STATUSES = ['Returned', 'UnDelivered'] as const

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

// Yerel mutabakat aggregate'inden canonical metrik özeti üretir (pure). İptal/
// iade tutarı statü bucket'larını CANONICAL disposition ile sınıflayarak toplar
// (tek kaynak): UnDelivered → return, UnSupplied → cancel. Böylece Dashboard,
// reconciliation ve diagnostic AYNI iade/iptal tutarını üretir.
export function toCanonicalSummary(input: {
  distinctPackageIds: number
  orderLineCount: number
  lineQuantityTotal: number
  totalAmount: number
  byMarketplaceStatus: { key: string; count: number; amount: number }[]
}): CanonicalMetricSummary {
  let cancelAmount = 0
  let returnAmount = 0
  for (const row of input.byMarketplaceStatus) {
    const disposition = classifyCanonicalDisposition(row.key)
    if (disposition === 'cancel') cancelAmount += row.amount
    else if (disposition === 'return') returnAmount += row.amount
  }
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
