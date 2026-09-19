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
  /** Ham değer ÇÖZÜLEMEDİ (normalize boş döndü). */
  | 'RAW_UNPARSEABLE'
  /**
   * Ham değer çözüldü ama KUSUR İMZASI KANITLANAMIYOR — ONARILMAZ.
   *
   * İki kaynak:
   *  1) Sapma ne 0 ne de tam ofset → bilinen kusurla AÇIKLANAMAZ.
   *  2) Ham değer OFSETSİZ (naive) dizgi → eski alım yolu onu SUNUCUNUN
   *     YEREL saatinde çözerdi; kaydın hangi saat diliminde yazıldığı
   *     GERİYE DÖNÜK BİLİNEMEZ. Resmî sözleşme yalnız SAYISAL epoch'u
   *     belgeler; belgelenmemiş bir biçim üzerinde otomatik yazma YAPILMAZ.
   */
  | 'AMBIGUOUS'

/**
 * Ham `orderDate` değerinin BİÇİMİ. Kusur analizinin ekseni budur: eski alım
 * yolu (`new Date(value).toISOString()`) biçime göre FARKLI davranırdı —
 * sayısal epoch +3 saat kayardı, açık ofsetli dizgi ise KAYMAZDI. Bu yüzden
 * "kaymış" ve "zaten doğru" satırların ayrımı TARİHTEN DEĞİL BİÇİMDEN
 * doğmuş olabilir; denetim aracı bunu bu alanla görünür kılar.
 */
export type TrendyolRawOrderDateShape =
  | 'EPOCH_MS'
  | 'OFFSET_STRING'
  | 'NAIVE_STRING'
  | 'UNPARSEABLE'
  | 'MISSING'

const EXPLICIT_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

export function classifyRawOrderDateShape(value: unknown): TrendyolRawOrderDateShape {
  if (value == null || value === '') return 'MISSING'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? 'EPOCH_MS' : 'UNPARSEABLE'
  }
  const text = String(value).trim()
  if (text === '') return 'MISSING'
  if (/^-?\d+$/.test(text)) {
    return Number.isFinite(Number(text)) ? 'EPOCH_MS' : 'UNPARSEABLE'
  }
  if (EXPLICIT_OFFSET.test(text)) {
    return Number.isFinite(Date.parse(text)) ? 'OFFSET_STRING' : 'UNPARSEABLE'
  }
  return Number.isFinite(Date.parse(`${text.replace(' ', 'T')}Z`))
    ? 'NAIVE_STRING'
    : 'UNPARSEABLE'
}

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
  // OFSETSİZ ham dizgi: eski alım yolu onu SUNUCU YERELİNDE çözerdi; kaydın
  // hangi saat diliminde yazıldığı geriye dönük KANITLANAMAZ. Sapma tam
  // ofset çıksa bile bu bir TESADÜF olabilir → otomatik onarım DIŞI.
  const shape = classifyRawOrderDateShape(input.rawOrderDate)
  if (shape === 'NAIVE_STRING') {
    return { correctedOrderDate: corrected, driftMinutes, classification: 'AMBIGUOUS' }
  }
  return {
    correctedOrderDate: corrected,
    driftMinutes,
    classification:
      driftMinutes === TRENDYOL_ORDER_DATE_OFFSET_MINUTES
        ? 'DRIFTED_BY_OFFSET'
        : driftMinutes === 0
          ? 'ALREADY_CORRECT'
          : // Çözüldü ama bilinen kusurla AÇIKLANAMIYOR: "okunamadı" DEĞİL.
            'AMBIGUOUS',
  }
}
