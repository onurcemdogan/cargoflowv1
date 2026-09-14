// TRENDYOL `orderDate` KAYMA SINIFLANDIRMASI — SAF (DB/IO YOK).
//
// TRENDYOL-ORDERDATE-TZ-001 yeni alımı düzeltir; kusurdan ÖNCE yazılmış
// satırlar 3 saat ileri kalır. Bu modül, kalıcı ham Trendyol yükünden
// çözülen ORİJİNAL `orderDate` ile KAYITLI değeri karşılaştırır.
//
// SAF OLMASININ SEBEBİ: CLI girişinden ayrı tutulur, böylece test DB
// bağlantısı OLMADAN sınıflandırmayı doğrulayabilir (CLI dosyası içe
// aktarıldığında `main()` çalışır ve DATABASE_URL ister).
import {
  normalizeTrendyolOrderDate,
  TRENDYOL_ORDER_DATE_OFFSET_MINUTES,
} from '../marketplaces/trendyolOrderDate.ts'

export type OrderDateDriftClassification =
  /** Kayıtlı değer düzeltilmişten TAM ofset kadar ileride — beklenen kusur imzası. */
  | 'DRIFTED_BY_OFFSET'
  /** Kayıtlı değer zaten doğru — yeniden düzeltme YAPILMAZ. */
  | 'ALREADY_CORRECT'
  /** Ham yük yok/okunamıyor — TAHMİN YAPILMAZ. */
  | 'RAW_UNAVAILABLE'
  /** Ham değer çözülemedi ya da fark beklenen imzaya uymuyor. */
  | 'RAW_UNPARSEABLE'

export interface OrderDateDriftVerdict {
  correctedOrderDate: string | null
  /** Kayıtlı değerin düzeltilmişten ne kadar İLERİDE olduğu (dakika). */
  driftMinutes: number | null
  classification: OrderDateDriftClassification
}

export function classifyOrderDateDrift(input: {
  storedOrderDate: Date | string | null
  rawOrderDate: unknown
}): OrderDateDriftVerdict {
  if (input.rawOrderDate == null || input.rawOrderDate === '') {
    return {
      correctedOrderDate: null,
      driftMinutes: null,
      classification: 'RAW_UNAVAILABLE',
    }
  }
  const corrected = normalizeTrendyolOrderDate(input.rawOrderDate)
  if (!corrected) {
    return {
      correctedOrderDate: null,
      driftMinutes: null,
      classification: 'RAW_UNPARSEABLE',
    }
  }
  const storedMs =
    input.storedOrderDate instanceof Date
      ? input.storedOrderDate.getTime()
      : Date.parse(String(input.storedOrderDate ?? ''))
  if (!Number.isFinite(storedMs)) {
    return {
      correctedOrderDate: corrected,
      driftMinutes: null,
      classification: 'RAW_UNAVAILABLE',
    }
  }
  const driftMinutes = Math.round((storedMs - Date.parse(corrected)) / 60_000)
  return {
    correctedOrderDate: corrected,
    driftMinutes,
    classification:
      driftMinutes === TRENDYOL_ORDER_DATE_OFFSET_MINUTES
        ? 'DRIFTED_BY_OFFSET'
        : driftMinutes === 0
          ? 'ALREADY_CORRECT'
          : 'RAW_UNPARSEABLE',
  }
}
