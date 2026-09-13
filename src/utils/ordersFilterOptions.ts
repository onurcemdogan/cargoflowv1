import type { OrderStatusFilter } from '../types/cargoflow.ts'
import type { OperationTabFilter } from './ordersTabs.ts'
import { mapMarketplaceStatus } from './statusPresentation.ts'
import { EXTERNAL_PROCESSING_LABEL } from './externalProcessing.ts'

// ═══ SİPARİŞLER EKRANI FİLTRE SEÇENEK MODELİ — TEK KAYNAK ═════════════════
//
// Seçenek listesi, görünen ad ve (yalnız sunum amaçlı) gruplama AYNI diziden
// türer. İkinci bir seçenek listesi YOKTUR: ekranda görünen her seçenek
// `ORDERS_STATUS_FILTER_OPTIONS` içinden gelir, gruplama da onu böler.
// İki ayrı liste olsaydı biri güncellenip diğeri unutulduğunda dropdown ile
// sorgu sessizce ayrışırdı.
//
// SORGU SEMANTİĞİ BU MODÜLDE DEĞİLDİR: filtreleme tek saf projeksiyonda
// (`buildVisibleOrders`) yapılır ve `value` alanları DEĞİŞMEZ.

/**
 * Pazaryeri (marketplace) statüleri — hem Türkçe etiket çözümü hem sunum
 * gruplaması bu TEK listeden türer.
 */
export const ORDERS_MARKETPLACE_STATUS_OPTIONS: readonly OrderStatusFilter[] = [
  'Created',
  'Picking',
  'Invoiced',
  'Shipped',
  'Delivered',
  'Cancelled',
  'Returned',
  'UnDelivered',
  'UnSupplied',
  'AtCollectionPoint',
  'Unknown',
]

/**
 * "Statü" dropdown'ının TAM seçenek kümesi.
 *
 * `'Etiket Oluşturuldu'` KALDIRILDI: projede bu değeri YAZAN tek bir satır
 * yoktu (ne `order.status`, ne `operation_status`; hiçbir üretim yolu
 * üretmiyordu) — dolayısıyla filtre her zaman boş sonuç döndürürdü.
 * `StatusBadge` içindeki render desteği ve `getOrderOperationStatus`
 * okuması KASITLI olarak KORUNDU: eski bir kayıt bu değeri taşıyorsa
 * görüntülenmeye devam eder.
 */
export const ORDERS_STATUS_FILTER_OPTIONS: readonly OrderStatusFilter[] = [
  'all',
  'Yeni',
  ...ORDERS_MARKETPLACE_STATUS_OPTIONS,
  'Ön Kayıt Yapıldı',
  'Kargo Oluşturuldu',
  'Etiket Hazır',
  'Etiket Basıldı',
  'Hata',
]

export type OrdersStatusFilterGroupKey = 'marketplace' | 'cargoflow'

/**
 * YALNIZ SUNUM GRUPLAMASI.
 *
 * "Statü" dropdown'ı iki ayrı domaini taşıyor: pazaryerinin bildirdiği paket
 * durumu ile CargoFlow'un kendi iş akışı durumu. Değerler ve sorgu semantiği
 * DEĞİŞMEZ; yalnız kullanıcı hangi soruyu sorduğunu görebilsin diye
 * `optgroup` ile ayrılırlar.
 */
export const ORDERS_STATUS_FILTER_GROUPS: ReadonlyArray<{
  key: OrdersStatusFilterGroupKey
  label: string
}> = [
  { key: 'marketplace', label: 'Pazaryeri Durumu' },
  { key: 'cargoflow', label: 'CargoFlow İş Akışı' },
]

/**
 * Seçeneğin hangi sunum grubuna düştüğü. `'all'` hiçbir gruba girmez
 * (dropdown'ın başında tek başına durur).
 *
 * `'Yeni'` pazaryeri grubundadır: kullanıcı için "pazaryerinden yeni gelmiş,
 * üzerinde işlem yapılmamış paket" anlamını taşır.
 */
export function resolveOrdersStatusFilterGroup(
  option: OrderStatusFilter,
): OrdersStatusFilterGroupKey | null {
  if (option === 'all') return null
  if (option === 'Yeni') return 'marketplace'
  return ORDERS_MARKETPLACE_STATUS_OPTIONS.includes(option)
    ? 'marketplace'
    : 'cargoflow'
}

/** Bir gruba düşen seçenekler — DAİMA ana listeden süzülerek. */
export function ordersStatusFilterOptionsForGroup(
  group: OrdersStatusFilterGroupKey,
): OrderStatusFilter[] {
  return ORDERS_STATUS_FILTER_OPTIONS.filter(
    (option) => resolveOrdersStatusFilterGroup(option) === group,
  )
}

/** Kullanıcıya görünen ad. Pazaryeri statüleri canonical Türkçe adını alır. */
export function ordersStatusFilterLabel(option: OrderStatusFilter): string {
  if (option === 'all') return 'Tümü'
  return ORDERS_MARKETPLACE_STATUS_OPTIONS.includes(option)
    ? mapMarketplaceStatus('trendyol', option).label
    : option
}

/**
 * "İşlem Durumu" filtresi seçenekleri: teknik yaşam-döngüsü durumlarına
 * (mevcut classifier'lar) kullanıcı dostu etiketlerle erişim.
 *
 * `labelReady` DEĞERİ DEĞİŞMEZ; yalnız görünen adı "Etiket Hazır"dır — rozet,
 * ana sekme ve Statü dropdown'ı aynı aşama için zaten bu adı kullanıyor;
 * "Etiket Basılacak" aynı şeyin ikinci adıydı.
 */
export const ORDERS_OPERATION_TAB_OPTIONS: ReadonlyArray<{
  key: OperationTabFilter
  label: string
}> = [
  { key: 'all', label: 'Tüm İşlem Durumları' },
  { key: 'barcodePending', label: 'Barkod Bekliyor' },
  { key: 'shipmentPending', label: 'Kargo Oluşturulacak' },
  { key: 'suratVerificationPending', label: 'Doğrulama Bekliyor' },
  { key: 'labelReady', label: 'Etiket Hazır' },
  { key: 'labelPrinted', label: 'Etiket Basıldı' },
  { key: 'archive', label: 'Arşiv' },
  // YEREL arşiv: kullanıcının manuel işaretlediği, başka bir entegrasyon
  // programında işlenen siparişler. Buradan geri alınabilirler.
  { key: 'externallyProcessed', label: EXTERNAL_PROCESSING_LABEL },
]
